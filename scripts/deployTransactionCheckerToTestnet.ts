import { Address, toNano } from '@ton/core';
import { TransactionCheckerContract } from '../wrappers/TonBridgeContest';
import { NetworkProvider } from '@ton/blueprint';
import { promises as fs } from "fs";

export async function run(provider: NetworkProvider) {
    const recently_deployed_lite_client_contract_address_raw = await fs.readFile(`tests/cache/recently_deployed_to_testnet_lite_client_contract_address.raw`);
    const lite_client_contract_address = new Address(0, recently_deployed_lite_client_contract_address_raw);

    // Deploying transaction-checker

    const transaction_checker_contract = provider.open(await TransactionCheckerContract.createFromConfig(lite_client_contract_address));

    await transaction_checker_contract.sendDeployTransactionChecker(provider.sender(), lite_client_contract_address, toNano('0.1'));

    await provider.waitForDeploy(transaction_checker_contract.address);
}