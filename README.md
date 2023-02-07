# Test for Key Handover between pRuntimes

## System Requirements

- Artifacts compiled under Ubuntu 22.04 using <https://github.com/Phala-Network/phala-blockchain/tree/handover-client>
- This only works under SGX HW mode

## Handover Requirements

There are two parties during handover: sender pRuntime and receiver pRuntime. They need to meet the following requirements so the handover can proceed:

- Both need to be in SGX HW, so they can generate RA report;
- They need to be on the same computer, a LA report is used to ensure this;
- Both pRuntime hashes (mr_enclave ++ isv_prod_id ++ isv_svn ++ mr_signer) are registered on-chain through `phala_registry::add_pruntime()`
  - And receiver is registered after the sender pRuntime version registration
- The sender pRuntime is synced
  - Will check the time gap between lastest block timestamp and RA report timestamp

## Run Test

Run with

```bash
# you may need to manually kill the processes after test is done
KEEP_TEST_FILES=1 yarn test:handover
```

You shall see similar logs in `pruntime_receiver.log` like

```log
[2023-02-07T15:41:33.227385Z INFO  pruntime] Starting handover from http://localhost:8100
[2023-02-07T15:41:33.227655Z INFO  pruntime::handover] Requesting for challenge
[2023-02-07T15:41:33.237657Z INFO  phactory_api::pruntime_client] Response: 200 OK
[2023-02-07T15:41:33.237691Z INFO  pruntime::handover] Challenge received
[2023-02-07T15:41:33.479596Z INFO  pruntime::ias] Getting RA report from https://api.trustedservices.intel.com/sgx/dev/attestation/v4/report
[2023-02-07T15:41:35.542135Z INFO  pruntime::handover] Requesting for key
[2023-02-07T15:41:37.663395Z INFO  phactory_api::pruntime_client] Response: 200 OK
[2023-02-07T15:41:37.663533Z INFO  pruntime::handover] Key received
[2023-02-07T15:41:37.664444Z INFO  phactory] Length of encoded slice: 103
[2023-02-07T15:41:37.665028Z INFO  phactory] Persistent Runtime Data V2 saved
[2023-02-07T15:41:37.665097Z INFO  pruntime] Handover done
```
