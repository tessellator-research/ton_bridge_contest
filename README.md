# Fastnet-Testnet Bridge

We present a complete, trustless and permissionless bridge between Fastnet and Testnet networks.

### All requested functionality is implemented

- Lite-client smart contract with fully functional 'new_key_block' and 'check_block' message handling.

- Transaction-checker smart contract that handles 'check_transaction' and responds with 'transaction_checked' message.

- A 'test-cli' program that takes user's wallet seed phrase and either verifies transaction presence in Masterchain or submits a new key block to the Lite-client.


### Preliminaries
Because at the time of the contest Fastchain does not contain any shards, the parseShards function in TonLiteClient throws an error during initialization. To work around that, go to `node_modules/ton-lite-client/dist/parser/parseShards.js` and change `throw Error('Invalid slice');` to `return new Map();` in the `parseShards` function.

### Test instructions

`export FIFTPATH="/path/to/ton/binaries/lib"; yarn test`

This sets enviroment variable FIFTPATH to "/path/to/ton/binaries/lib" and runs contract tests.

### Build instructions
First, set `WALLET_MNEMONIC` and `WALLET_VERSION` variables. For example:

`export WALLET_MNEMONIC="crop drama dizzy mesh case claw bunker again share divide sick scrub hen retreat token wrap razor endorse zebra mention system clerk reopen stumble"; export WALLET_VERSION="v3r2";`

Run these two commands in the following order: 

`yarn blueprint run deployLiteClientToTestnet --testnet --mnemonic`

`yarn blueprint run deployTransactionCheckerToTestnet --testnet --mnemonic`

These commands deploy lite-client and transaction-checker to the testnet, to check Fastnet's blocks and transactions on Testnet.

The order matters, since transaction-checker contains lite-client's address that is used to checking transactions' blocks.

### CLI instructions
Before interacting with lite-client or transaction-checker smart contracts make sure to fill `cli_wallet_v3r2.txt` file with your Testnet wallet's seed phrase. Keep your balance > 0.2 TON (Testnet tokens) in order to pay for smart-contracts' functions calls.

Keep in mind that the contracts verify blocks and transaction from Fastnet, so fill the arguments of the CLI accordingly.
To list all instructions run:

`npm run testnet-cli`
To check up to the latest key block with new validators run:

`npm run testnet-cli new_key_block`
To check some block in the contract's known epoch run this command specifying block's seqno in `seqno`:

`npm run testnet-cli check_block <seqno>`
To check some transaction in the contract's known epoch run this command specifying block's seqno in `seqno` and transaction hash in `tx_hash`:

`npm run testnet-cli check_transaction <seqno> <tx_hash>`

### Contract addresses
Lite-client contract address on testnet: `kQByYIrCzbv0jqGX-8SbmqIgjZ4V2_oZCm6zyr_w5BF6r0s9`

Transaction-checker contract address on testnet: `kQBP5NIkNLey6-X3Sr7SHjiQHMIrqv-rYiEhU-kjTILQcRoK`

Fastnet contracts could not be deployed because the faucet did not provide sufficient coins.

## Project structure

-   `contracts` - source code of all smart contracts of the project and their dependencies.
-   `wrappers` - wrapper classes (implementing `Contract` from ton-core) for the contracts, including any [de]serialization primitives and compilation functions.
-   `tests` - tests for the contracts.
-   `scripts` - scripts used by the project, mainly the deployment scripts.
