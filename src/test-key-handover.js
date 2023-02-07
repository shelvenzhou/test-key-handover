require('dotenv').config();
const { assert } = require('chai');
const path = require('path');
const portfinder = require('portfinder');
const fs = require('fs');
const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
const Phala = require('@phala/sdk');
const { typeDefinitions } = require('@polkadot/types/bundle');

const { types, typeAlias, typeOverrides } = require('./utils/typeoverride');

const { Process, TempDir } = require('./utils/pm');
const { PRuntimeApi } = require('./utils/pruntime');
const { checkUntil, skipSlowTest, sleep } = require('./utils');

const senderVersion = 'nightly-2023-02-02';
const receiverVersion = 'nightly-2023-02-03';

const pathNode = path.resolve(`./artifacts/${senderVersion}/phala-node`);
const pathRelayer = path.resolve(`./artifacts/${senderVersion}/pherry`);

const inSgx = true;
const sgxLoader = "gramine-sgx";
const pRuntimeBin = "pruntime";
const pRuntimeHash = "pruntime.hash";

const pRuntimeDir = path.resolve(`./artifacts/${senderVersion}`);
const pathPRuntime = path.resolve(`${pRuntimeDir}/${pRuntimeBin}`);
const pathPRuntimeHash = path.resolve(`${pRuntimeDir}/${pRuntimeHash}`);

const receiverPRuntimeDir = path.resolve(`./artifacts/${receiverVersion}`);
const pathReceiverPRuntime = path.resolve(`${receiverPRuntimeDir}/${pRuntimeBin}`);
const pathReceiverPRuntimeHash = path.resolve(`${receiverPRuntimeDir}/${pRuntimeHash}`);

describe('A full stack', function () {
    this.timeout(160000);

    let cluster;
    let api, keyring, alice, bob;
    let pruntime;
    const tmpDir = new TempDir();
    const tmpPath = tmpDir.dir;

    before(async () => {
        // Check binary files
        [pathNode, pathRelayer, pathPRuntime, pathReceiverPRuntime].map(fs.accessSync);
        // Bring up a cluster
        cluster = new Cluster(1, pathNode, pathRelayer, pathPRuntime, pathReceiverPRuntime, tmpPath);
        await cluster.start();
        // APIs
        api = await cluster.api;
        pruntime = cluster.workers.map(w => w.api);
        // Create polkadot api and keyring
        await cryptoWaitReady();
        keyring = new Keyring({ type: 'sr25519', ss58Format: 30 });
        alice = keyring.addFromUri('//Alice');
        bob = keyring.addFromUri('//Bob');
    });

    after(async function () {
        // TODO: consider handle the signals and process.on('exit') event:
        //   https://stackoverflow.com/questions/14031763/doing-a-cleanup-action-just-before-node-js-exits
        if (api) await api.disconnect();
        await cluster.kill();
        if (process.env.KEEP_TEST_FILES != '1') {
            tmpDir.cleanup();
        } else {
            console.log(`The test datadir is kept at ${cluster.tmpPath}`);
        }
    });

    it('should be up and running', async function () {
        assert.isFalse(cluster.processNode.stopped);
        for (const w of cluster.workers) {
            assert.isFalse(w.processRelayer.stopped);
            assert.isFalse(w.processPRuntime.stopped);
        }
    });

    let workerKey;
    describe('pRuntime', () => {
        it('can register pRuntime hashes', async function () {
            const pRuntimeHash = fs.readFileSync(pathPRuntimeHash, 'utf8').trim();
            console.log(`Sender pRuntime hash: ${pRuntimeHash}`);
            await assert.txAccepted(
                api.tx.sudo.sudo(
                    api.tx.phalaRegistry.addPruntime(hex(pRuntimeHash))
                ),
                alice,
            );
            assert.isTrue(await checkUntil(async () => {
                const time = await api.query.phalaRegistry.pRuntimeAddedAt(hex(pRuntimeHash));
                console.log(`${time.unwrap()}`)
                return time.isSome;
            }, 6000), 'pRuntime hash not registered');

            const receiverPRuntimeHash = fs.readFileSync(pathReceiverPRuntimeHash, 'utf8').trim();
            console.log(`Receiver pRuntime hash: ${receiverPRuntimeHash}`);
            await assert.txAccepted(
                api.tx.sudo.sudo(
                    api.tx.phalaRegistry.addPruntime(hex(receiverPRuntimeHash))
                ),
                alice,
            );
            assert.isTrue(await checkUntil(async () => {
                const time = await api.query.phalaRegistry.pRuntimeAddedAt(hex(receiverPRuntimeHash));
                return time.isSome;
            }, 6000), 'receiver pRuntime hash not registered');
        });

        it('is initialized', async function () {
            let info;
            assert.isTrue(await checkUntil(async () => {
                info = await pruntime[0].getInfo();
                return info.initialized;
            }, 1000), 'not initialized in time');
            // A bit guly. Any better way?
            workerKey = Uint8Array.from(Buffer.from(info.system.publicKey, 'hex'));
        });

        it('can sync block', async function () {
            assert.isTrue(await checkUntil(async () => {
                const info = await pruntime[0].getInfo();
                return info.blocknum > 0;
            }, 7000), 'stuck at block 0');
        });

        it('is registered', async function () {
            if (skipSlowTest()) {
                this.skip();
            }
            // Finalization takes 2-3 blocks. So we wait for 3 blocks here.
            assert.isTrue(await checkUntil(async () => {
                const info = await pruntime[0].getInfo();
                return info.system?.registered;
            }, 4 * 6000), 'not registered in time');
        });

        it('finishes the benchmark', async function () {
            if (skipSlowTest()) {
                this.skip();
            }
            assert.isTrue(await checkUntil(async () => {
                const workerInfo = await api.query.phalaRegistry.workers(workerKey);
                return workerInfo.unwrap().initialScore.isSome;
            }, 3 * 6000), 'benchmark timeout');
        });
    });

    describe('key handover', () => {
        it('can do handover', async function () {
            await cluster.launchHandoverPRuntime();
        });
    });
});

class Cluster {
    constructor(numWorkers, pathNode, pathRelayer, pathPRuntime, pathReceiverPRuntime, tmpPath) {
        this.numWorkers = numWorkers;
        this.pathNode = pathNode;
        this.pathRelayer = pathRelayer;
        this.pathPRuntime = pathPRuntime;
        this.pathReceiverPRuntime = pathReceiverPRuntime;
        this.tmpPath = tmpPath;
        [pathNode, pathRelayer, pathPRuntime].map(fs.accessSync);
        // Prepare empty workers
        const workers = [];
        for (let i = 0; i < this.numWorkers; i++) {
            workers.push({});
        }
        this.workers = workers;
        this.receiverWorker = {};
    }

    async start() {
        await this._reservePorts();
        this._createProcesses();
        await this._launchAndWait();
        await this._createApi();
    }

    async kill() {
        await Promise.all([
            this.processNode.kill(),
            ...this.workers.map(w => [
                w.processPRuntime.kill('SIGKILL'),
                w.processRelayer.kill()
            ]).flat(),
            this.receiverWorker?.processPRuntime.kill('SIGKILL'),
        ]);
    }

    // Returns false if waiting is timeout; otherwise it restart the specified worker
    async waitWorkerExitAndRestart(i, timeout) {
        const w = this.workers[i];
        const succeed = await checkUntil(async () => {
            return w.processPRuntime.stopped && w.processRelayer.stopped
        }, timeout);
        if (!succeed) {
            return false;
        }
        this._createWorkerProcess(i);
        await waitPRuntimeOutput(w.processPRuntime);
        await waitRelayerOutput(w.processRelayer);
        return true;
    }

    async _reservePorts() {
        const [wsPort, ...workerPorts] = await Promise.all([
            portfinder.getPortPromise({ port: 9944 }),
            ...this.workers.map((w, i) => portfinder.getPortPromise({ port: 8100 + i * 10 }))
        ]);
        this.wsPort = wsPort;
        this.workers.forEach((w, i) => w.port = workerPorts[i]);
    }

    _createProcesses() {
        this.processNode = newNode(this.wsPort, this.tmpPath, 'node');
        this.workers.forEach((_, i) => {
            this._createWorkerProcess(i);
        })
        this.processes = [
            this.processNode,
            ...this.workers.map(w => [w.processRelayer, w.processPRuntime]).flat()
        ];
    }

    _createWorkerProcess(i) {
        const AVAILABLE_ACCOUNTS = [
            '//Alice',
            '//Bob',
            '//Charlie',
            '//Dave',
            '//Eve',
            '//Ferdie',
        ];
        const w = this.workers[i];
        const gasAccountKey = AVAILABLE_ACCOUNTS[i];
        w.processRelayer = newRelayer(this.wsPort, w.port, this.tmpPath, gasAccountKey, '', `relayer${i}`);
        w.processPRuntime = newPRuntime(pRuntimeDir, w.port, this.tmpPath, `pruntime${i}`);
    }

    async launchHandoverPRuntime() {
        // launch receiver pRuntime to do handover
        this.receiverWorker.processPRuntime = newPRuntime(receiverPRuntimeDir, 18000, this.tmpPath, `pruntime_receiver`, ['--request-handover-from', `http://localhost:${this.workers[0].port}`]);
        await waitPRuntimeHandover(this.receiverWorker.processPRuntime);
    }

    async _launchAndWait() {
        // Launch nodes & pruntime
        await Promise.all([
            waitNodeOutput(this.processNode),
            ...this.workers.map(w => waitPRuntimeOutput(w.processPRuntime)),
        ]);
        // Launch relayers
        await Promise.all(this.workers.map(w => waitRelayerOutput(w.processRelayer)));
    }

    async _createApi() {
        this.api = await ApiPromise.create({
            provider: new WsProvider(`ws://localhost:${this.wsPort}`),
            types: { ...types, ...typeDefinitions, ...Phala.types, ...typeOverrides },
            typeAlias
        });
        this.workers.forEach(w => {
            w.api = new PRuntimeApi(`http://localhost:${w.port}`);
        })
    }

}

function waitPRuntimeHandover(p) {
    return p.startAndWaitForOutput(/Handover done/);
}
function waitPRuntimeOutput(p) {
    return p.startAndWaitForOutput(/Rocket has launched from/);
}
function waitRelayerOutput(p) {
    return p.startAndWaitForOutput(/runtime_info: InitRuntimeResp/);
}
function waitNodeOutput(p) {
    return p.startAndWaitForOutput(/Imported #1/);
}


function newNode(wsPort, tmpPath, name = 'node') {
    const cli = [
        pathNode, [
            '--dev',
            '--block-millisecs=1000',
            '--base-path=' + path.resolve(tmpPath, 'phala-node'),
            `--ws-port=${wsPort}`,
            '--rpc-methods=Unsafe',
            '--pruning=archive',
        ]
    ];
    const cmd = cli.flat().join(' ');
    fs.writeFileSync(`${tmpPath}/start-${name}.sh`, `#!/bin/bash\n${cmd}\n`, { encoding: 'utf-8' });
    return new Process(cli, { logPath: `${tmpPath}/${name}.log` });
}

function newPRuntime(pRuntimeDir, teePort, tmpPath, name = 'app', extra_args = []) {
    const workDir = path.resolve(`${tmpPath}/${name}`);
    const sealDir = path.resolve(`${workDir}/data`);
    if (!fs.existsSync(workDir)) {
        if (inSgx) {
            fs.cpSync(pRuntimeDir, workDir, { recursive: true })
            fs.mkdirSync(path.resolve(`${sealDir}/protected_files/`), { recursive: true });
            fs.mkdirSync(path.resolve(`${sealDir}/storage_files/`), { recursive: true });
        } else {
            fs.mkdirSync(sealDir, { recursive: true });
            const filesMustCopy = ['Rocket.toml', pRuntimeBin];
            filesMustCopy.forEach(f =>
                fs.copyFileSync(`${pRuntimeDir}/${f}`, `${workDir}/${f}`)
            );
        }
    }
    const args = [
        '--cores=0',  // Disable benchmark
        '--port', teePort.toString(),
    ];
    args.push(...extra_args);

    let bin = pRuntimeBin;
    if (inSgx) {
        bin = sgxLoader;
        args.splice(0, 0, pRuntimeBin);
    }
    return new Process([
        `${workDir}/${bin}`, args, {
            cwd: workDir,
            env: {
                ...process.env,
                ROCKET_PORT: teePort.toString(),
                RUST_LOG: 'debug'
            }
        }
    ], { logPath: `${tmpPath}/${name}.log` });
}

function newRelayer(wsPort, teePort, tmpPath, gasAccountKey, key = '', name = 'relayer') {
    const args = [
        '--no-wait',
        `--mnemonic=${gasAccountKey}`,
        `--substrate-ws-endpoint=ws://localhost:${wsPort}`,
        `--pruntime-endpoint=http://localhost:${teePort}`,
        '--dev-wait-block-ms=1000',
        '--attestation-provider', 'ias',
    ];

    if (key) {
        args.push(`--inject-key=${key}`);
    }

    return new Process([
        pathRelayer, args
    ], { logPath: `${tmpPath}/${name}.log` });
}

function hex(b) {
    if (!b.startsWith('0x')) {
        return '0x' + b;
    } else {
        return b;
    }
}

async function assertSubmission(txBuilder, signer, shouldSucceed = true) {
    return await new Promise(async (resolve, _reject) => {
        const unsub = await txBuilder.signAndSend(signer, { nonce: -1 }, (result) => {
            if (result.status.isInBlock) {
                let error;
                for (const e of result.events) {
                    const { event: { data, method, section } } = e;
                    if (section === 'system' && method === 'ExtrinsicFailed') {
                        if (shouldSucceed) {
                            error = data[0];
                        } else {
                            unsub();
                            resolve(error);
                        }
                    }
                }
                if (error) {
                    assert.fail(`Extrinsic failed with error: ${error}`);
                }
                unsub();
                resolve({
                    hash: result.status.asInBlock,
                    events: result.events,
                });
            } else if (result.status.isInvalid) {
                assert.fail('Invalid transaction');
                unsub();
                resolve();
            }
        });
    });
}
assert.txAccepted = assertSubmission;
assert.txFailed = (txBuilder, signer) => assertSubmission(txBuilder, signer, false);
