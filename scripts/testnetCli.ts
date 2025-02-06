import { Command } from "commander";
import { promises as fs } from "fs";
import { fetch_block, fetch_block_and_transaction_by_seqno, fetch_key_block_with_next_validators_by_seqno, get_block_raw, get_block_root_and_file_hashes, get_blockchain_query_client, get_mc_block_by_seqno, get_random_uint_64, hex_to_uint8array, LSPair, parse_block_raw, sleep, uint8array_to_hex } from "./utils";
import { Address, beginCell, Cell, Dictionary, internal, OpenedContract, parseTuple, toNano } from "@ton/core";
import { tonNode_BlockIdExt } from "ton-lite-client/dist/schema";
import { WalletContractV3R2 } from "@ton/ton";
import { KeyPair, mnemonicToPrivateKey } from "@ton/crypto";
import { exit } from "process";


/*

This is a tool that helps forming and sending messages attesting Fastnet transactions and blocks to TON Testnet bridge contracts.
Replace contents of "cli_wallet_v3r2.txt" file with your own seed phrase. Make sure to use V3R2 wallet

*/

let wallet: WalletContractV3R2;
let wallet_keys: KeyPair;
let wallet_contract: OpenedContract<WalletContractV3R2>;
let wallet_mnemonic: string[] = [];

const lite_client_testnet_addr = Address.parseFriendly("kQAbPU_446k6HSRfgS5rSDMzVYeufu3TmX0AkjBAdPXIHX_b");
const transaction_checker_testnet_addr = Address.parseFriendly("kQDCHYRPSYb2p7c9vaTB80-jCshBeLsIX29rUbKl6qPK_5XT");

let testnet_ls_pair: LSPair;
let fastnet_ls_pair: LSPair;

async function acquire_mnemonic() {
    const wallet_mnemonic_words = (await fs.readFile(`cli_wallet_v3r2.txt`, "utf8"));  // Replace file contents with your own seed phrase; make sure to use V3R2 wallet
    if (wallet_mnemonic_words) {
        console.log("✅ Acquired wallet's mnemonic.");
        wallet_mnemonic = wallet_mnemonic_words.split(" ");
        return;
    }
}

async function prepare_wallet() {
    wallet_keys = await mnemonicToPrivateKey(wallet_mnemonic);
    wallet = WalletContractV3R2.create({ workchain: 0, publicKey: wallet_keys.publicKey });
    wallet_contract = testnet_ls_pair.client.open(wallet);
}

async function get_proper_key_blocks_chain(ls_pair: LSPair, mc_info: tonNode_BlockIdExt, until_seqno: number) {
    const mc_seqno = mc_info.seqno;
    const mc_root_hash = mc_info.rootHash;
    const mc_file_hash = mc_info.fileHash;
    const parsed_mc_block = await parse_block_raw(await get_block_raw(ls_pair, mc_seqno, mc_root_hash, mc_file_hash, -1, "-9223372036854775808"));
    let last_key_block_seqno = parsed_mc_block.info.prev_key_block_seqno;
    let proper_blocks_seqnos = [];
    while (true) {
        await sleep(250);
        const block_i = await get_mc_block_by_seqno(ls_pair, last_key_block_seqno);
        if (block_i.extra.custom.config.config.map.get("24")) {
            if (block_i.info.seq_no <= until_seqno) {
                break;
            }
            proper_blocks_seqnos.unshift(block_i.info.seq_no);
        }
        last_key_block_seqno = block_i.info.prev_key_block_seqno;
    }
    if (proper_blocks_seqnos[0] < until_seqno) {
        proper_blocks_seqnos.shift();
    }
    return proper_blocks_seqnos;
}

async function wallet_send_tx(value: bigint, payload: Cell, address: Address = lite_client_testnet_addr.address) {
    const current_wallet_seqno = await wallet_contract.getSeqno();
    const result = await wallet_contract.sendTransfer({
        seqno: current_wallet_seqno,
        secretKey: wallet_keys.secretKey,
        messages: [
            internal({
                to: address,
                value: value,
                bounce: true,
                body: payload
            })
        ],
        sendMode: 1
    });
    if (result === undefined) {
        let cur_seqno = current_wallet_seqno;
        while(cur_seqno === current_wallet_seqno) {
            cur_seqno = await wallet_contract.getSeqno();
            await sleep(750);
        }
        return {ok: true, result};
    }
    return {ok: false, result};
}

function utime_now(): number {
    // @ts-ignore
    return ((new Date()) / 1000).toFixed(0);
}

async function terminate(f: number) {
    console.log("👋 Terminating...", f);
    testnet_ls_pair.engine.close();
    return exit(0);
}

const program = new Command();

program
    .version("0.1.0")
    .description("CLI for lite-client & transaction-checker operations");

program
    .command("new_key_block")
    .description("Fetch the latest key block with information about the next epoch (i.e ConfigParam 36) and send it to the lite-client")
    .action(async () => {
        await acquire_mnemonic();
        console.log("📝 Connecting to lite server...");
        testnet_ls_pair = await get_blockchain_query_client("testnet");
        fastnet_ls_pair = await get_blockchain_query_client("fastnet");
        await prepare_wallet();
        
        const last_mc_block = (await testnet_ls_pair.client.getMasterchainInfo()).last;
        const current_validators_info_raw = Cell.fromBase64((await testnet_ls_pair.client.runMethod(lite_client_testnet_addr.address, "get_validators_info", Buffer.from([]), last_mc_block)).result!);
        const current_validators_info = parseTuple(current_validators_info_raw);
        // @ts-ignore
        const [current_validators_utime_until, current_validators_total_weight, current_validators_raw_dict, next_validators_utime_until, next_validators_total_weight, next_validators_raw_dict, latest_known_epoch_block_seqno] = [Number(current_validators_info[0].value), current_validators_info[1].value, current_validators_info[2].cell, Number(current_validators_info[3].value), current_validators_info[4].value, current_validators_info[5].cell, Number(current_validators_info[6].value)];

        const now = utime_now();
        if (now < next_validators_utime_until) {
            console.log(`✅ Contract's state is up-to-date!`);
            return await terminate(-1);
        }
        if (now > current_validators_utime_until) {
            console.log("📝 Contract's not up-to-date with the latest epoch. We'll fetch a chain of missing key blocks. It may take some time.");
            if ((await wallet_contract.getBalance()) < toNano("0.2")) {
                console.log(`⛔ Can't call "new_key_block" function due to insufficient balance. At least 0.2 TON is needed.`);
                return await terminate(0);
            }
            const proper_blocks_seqnos = await get_proper_key_blocks_chain(fastnet_ls_pair, (await fastnet_ls_pair.client.getMasterchainInfo()).last, latest_known_epoch_block_seqno);
            if (proper_blocks_seqnos.length === 0) {
                console.log(`✅ Turns out contract's state is already up-to-date!`);
                return await terminate(1);
            }
            console.log(`✅ Acquired a chain of missing key blocks that needs to be loaded to the contract for it to keep up with the latest epoch. These are their seqnos: ${proper_blocks_seqnos.join(", ")}\n`);
            console.log(`📝 Calling "new_key_block" ${proper_blocks_seqnos.length} times. Or until wallet runs out of balance... It might take a while!`);
            for (let i = 0; i < proper_blocks_seqnos.length; i++) {
                if ((await wallet_contract.getBalance()) < toNano("0.2")) {
                    console.log(`⛔ Insufficient balance for calling "new_key_block" function. Remaining ${proper_blocks_seqnos.length - i} calls for the lite-client to keep up with the newest state of the blockchain.`);
                    return await terminate(2);
                }
                const proper_block_seqno = proper_blocks_seqnos[i];
                const proper_key_block = await fetch_key_block_with_next_validators_by_seqno(fastnet_ls_pair, proper_block_seqno);
                const result = await wallet_send_tx(toNano("0.2"), beginCell()
                                                .storeUint(0x11a78ffe, 32)
                                                .storeUint(get_random_uint_64(), 64)
                                                .storeRef(proper_key_block.block)
                                                .storeDict(proper_key_block.block_signatures, Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(64))
                                                .storeUint(proper_key_block.file_hash, 256)
                                                .storeBit(false)
                                                .endCell());
                if (!result.ok) {
                    console.log("❌ Something went wrong...");
                    console.log(result);
                    return await terminate(3);
                }
                console.log(`✅ Successfully updated contract's state with new keyblock with seqno=${proper_block_seqno}`);
                await sleep(500);
            }
            console.log(`✅ Now the contract's state is up-to-date with the latest epoch.`);
        } else {
            console.log(`✅ The contract's state already is up-to-date with the latest epoch. That means you can call "check_block" and "check_transaction" functions on blocks & transactions of the last epoch!`);
        }

        return await terminate(4);
    });

program
    .command("check_block <seqno>")
    .description("Check the validity of a specific block from known epoch")
    .action(async (seqno_: string) => {
        const seqno = Number(seqno_);
        
        await acquire_mnemonic();
        console.log("📝 Connecting to lite server...");
        testnet_ls_pair = await get_blockchain_query_client("testnet");
        fastnet_ls_pair = await get_blockchain_query_client("fastnet");
        await prepare_wallet();
        
        const last_mc_block = (await testnet_ls_pair.client.getMasterchainInfo()).last;
        const current_validators_info_raw = Cell.fromBase64((await testnet_ls_pair.client.runMethod(lite_client_testnet_addr.address, "get_validators_info", Buffer.from([]), last_mc_block)).result!);
        const current_validators_info = parseTuple(current_validators_info_raw);
        // @ts-ignore
        const [current_validators_utime_until, current_validators_total_weight, current_validators_raw_dict, next_validators_utime_until, next_validators_total_weight, next_validators_raw_dict, latest_known_epoch_block_seqno] = [Number(current_validators_info[0].value), current_validators_info[1].value, current_validators_info[2].cell, Number(current_validators_info[3].value), current_validators_info[4].value, current_validators_info[5].cell, Number(current_validators_info[6].value)];

        console.log("📝 Acquiring information about block...");
        const { root_hash, file_hash } = await get_block_root_and_file_hashes(fastnet_ls_pair, seqno, -1, "-9223372036854775808");
        const block_raw = await get_block_raw(fastnet_ls_pair, seqno, root_hash, file_hash, -1, "-9223372036854775808", true);
        const block_parsed = await parse_block_raw(block_raw);

        if (block_parsed.info.gen_utime > next_validators_utime_until) {
            console.log(`❗ Contract's state is not up-to-date with the block's epoch. Consider calling "new_key_block" function until the contract's state is in sync with this block's epoch.`);
            return await terminate(5);
        }

        const current_validators = Dictionary.loadDirect(Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(45), current_validators_raw_dict);
        const next_validators = Dictionary.loadDirect(Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(45), next_validators_raw_dict);
        
        if ((await wallet_contract.getBalance()) < toNano("0.2")) {
            console.log(`⛔ Can't call "check_block" function due to insufficient balance. At least 0.2 TON is needed.`);
            return await terminate(6);
        }
        
        const { block, block_signatures, weak_signatures_from_archival_node, do_validators_switch_for_check_block } = await fetch_block(fastnet_ls_pair, seqno, current_validators_total_weight, current_validators, next_validators_total_weight, next_validators, block_raw, root_hash, file_hash);

        if (weak_signatures_from_archival_node) {
            console.log(`⛔ Lite server has returned weak signatures for this block.`);
            return await terminate(7);
        }

        const this_query_id = get_random_uint_64();
        console.log(`📝 Calling "check_block" function on block with seqno=${seqno}...`);
        const result = await wallet_send_tx(toNano("0.2"), beginCell()
                                                                .storeUint(0x8eaa9d76, 32)
                                                                .storeUint(this_query_id, 64)
                                                                .storeRef(block!)
                                                                .storeDict(block_signatures, Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(64))
                                                                .storeUint(BigInt("0x" + uint8array_to_hex(file_hash)), 256)
                                                                .storeUint(Number(do_validators_switch_for_check_block), 1)
                                                           .endCell());
        if (!result.ok) {
            console.log("❌ Something went wrong...");
            console.log(result);
            return await terminate(8);
        }
        console.log(`📝 Function responded without errors. Please, double check the result in your wallet.`);
        return await terminate(9);
    });

program
    .command("check_transaction <seqno> <tx_hash>")
    .description("Check the validity of the given transaction by it's hash and block's seqno")
    .action(async (seqno_: string, tx_hash: string) => {
        const seqno = Number(seqno_);

        await acquire_mnemonic();
        console.log("📝 Connecting to lite server...");
        testnet_ls_pair = await get_blockchain_query_client("testnet");
        fastnet_ls_pair = await get_blockchain_query_client("fastnet");
        await prepare_wallet();

        const last_mc_block = (await testnet_ls_pair.client.getMasterchainInfo()).last;
        const current_validators_info_raw = Cell.fromBase64((await testnet_ls_pair.client.runMethod(lite_client_testnet_addr.address, "get_validators_info", Buffer.from([]), last_mc_block)).result!);
        const current_validators_info = parseTuple(current_validators_info_raw);
        // @ts-ignore
        const [current_validators_utime_until, current_validators_total_weight, current_validators_raw_dict, next_validators_utime_until, next_validators_total_weight, next_validators_raw_dict, latest_known_epoch_block_seqno] = [Number(current_validators_info[0].value), current_validators_info[1].value, current_validators_info[2].cell, Number(current_validators_info[3].value), current_validators_info[4].value, current_validators_info[5].cell, Number(current_validators_info[6].value)];

        console.log("📝 Acquiring information about block...");
        const { root_hash, file_hash } = await get_block_root_and_file_hashes(fastnet_ls_pair, seqno, -1, "-9223372036854775808");
        const block_raw = await get_block_raw(fastnet_ls_pair, seqno, root_hash, file_hash, -1, "-9223372036854775808", true);
        const block_parsed = await parse_block_raw(block_raw);

        if (block_parsed.info.gen_utime > next_validators_utime_until) {
            console.log(`❗ Contract's state is not up-to-date with the block's epoch. Consider calling "new_key_block" function until the contract's state is in sync with this block's epoch.`);
            return await terminate(10);
        }

        const current_validators = Dictionary.loadDirect(Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(45), current_validators_raw_dict);
        const next_validators = Dictionary.loadDirect(Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(45), next_validators_raw_dict);

        if ((await wallet_contract.getBalance()) < toNano("0.2")) {
            console.log(`⛔ Can't call "check_transaction" function due to insufficient balance. At least 0.2 TON is needed.`);
            return await terminate(11);
        }

        
        const { block_signatures, account_dict_key, transaction_dict_key, transaction_cell, do_validators_switch_for_check_block } = await fetch_block_and_transaction_by_seqno(fastnet_ls_pair, seqno, current_validators_total_weight, current_validators, next_validators_total_weight, next_validators, BigInt("0x" + tx_hash));

        const result = await wallet_send_tx(toNano("0.2"), beginCell()
                                                            .storeUint(0x91d555f7, 32)
                                                            .storeRef(Cell.fromBoc(block_raw)[0])
                                                            .storeDict(block_signatures, Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(64))
                                                            .storeUint(BigInt("0x" + uint8array_to_hex(file_hash)), 256)
                                                            .storeUint(account_dict_key, 256)
                                                            .storeUint(transaction_dict_key, 64)
                                                            .storeRef(transaction_cell)
                                                            .storeUint(Number(do_validators_switch_for_check_block), 1)
                                                           .endCell(), transaction_checker_testnet_addr.address);
        if (!result.ok) {
            console.log("❌ Something went wrong...");
            console.log(result);
            return await terminate(12);
        }
        console.log(`📝 Function responded without errors. Please, double check the result in your wallet.`);
        return await terminate(13);
    });

program.parse(process.argv);
