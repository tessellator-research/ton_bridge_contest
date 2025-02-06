import { toNano } from '@ton/core';
import { LiteClientContract } from '../wrappers/TonBridgeContest';
import { NetworkProvider } from '@ton/blueprint';
import { get_blockchain_query_client, get_recent_proper_key_blocks } from './utils';
import { promises as fs } from "fs";

export async function run(provider: NetworkProvider) {
    let testnet_ls_pair = await get_blockchain_query_client("testnet");
    let fastnet_ls_pair = await get_blockchain_query_client("fastnet");

    const fastnet_proper_key_blocks_seqnos = await get_recent_proper_key_blocks(fastnet_ls_pair, 1);

    // Deploying lite-client
    const lite_client_contract_from_config = await LiteClientContract.createFromConfig(fastnet_ls_pair, fastnet_proper_key_blocks_seqnos[0]);

    const lite_client_contract = provider.open(lite_client_contract_from_config);

    await lite_client_contract.sendDeployLiteClient(provider.sender(), lite_client_contract_from_config.init!.data, fastnet_proper_key_blocks_seqnos[0], toNano('0.1'));

    await fs.writeFile(`tests/cache/recently_deployed_to_testnet_lite_client_contract_address.raw`, lite_client_contract.address.hash);

    await provider.waitForDeploy(lite_client_contract.address);

}