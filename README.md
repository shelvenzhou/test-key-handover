# Test for Key Handover between pRuntimes

## System Requirements

- Artifacts compiled under Ubuntu 22.04
- This only works under SGX HW mode

## Handover Requirements

- The receiver pRuntime is registered on-chain
- The sender pRuntime is synced
  - Will check the time gap between lastest block timestamp and RA report timestamp
- Both receiver and sender pRuntime will do a Remote Attestation

## Run Test

Run with

```bash
# you may need to manually kill the processes after test is done
KEEP_TEST_FILES=1 yarn test:handover
```

You shall see similar logs in `pruntime_receiver.log` like

```log
[2023-02-06T03:09:03.506023Z INFO  pruntime] Starting handover from http://localhost:8100
[2023-02-06T03:09:03.506276Z INFO  pruntime::handover] Requesting for challenge
[2023-02-06T03:09:03.516177Z INFO  phactory_api::pruntime_client] Response: 200 OK
[2023-02-06T03:09:03.516206Z INFO  pruntime::handover] Challenge received
[2023-02-06T03:09:03.516302Z INFO  phactory::prpc_service] Omit RA report in challenge response in dev mode
[2023-02-06T03:09:03.516318Z INFO  pruntime::handover] Requesting for key
[2023-02-06T03:09:03.517516Z INFO  phactory_api::pruntime_client] Response: 200 OK
[2023-02-06T03:09:03.517535Z INFO  pruntime::handover] Key received
[2023-02-06T03:09:03.517561Z INFO  phactory::prpc_service] Skip RA report check in dev mode
[2023-02-06T03:09:03.517690Z INFO  phactory] Length of encoded slice: 103
[2023-02-06T03:09:03.517880Z INFO  phactory] Persistent Runtime Data V2 saved
[2023-02-06T03:09:03.517897Z INFO  pruntime] Handover done
```
