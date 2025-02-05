import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Cell, Dictionary, toNano } from "@ton/core";
import { LiteClientContract, TransactionCheckerContract } from "../wrappers/TonBridgeContest";
import "@ton/test-utils";
import { compile } from "@ton/blueprint";
import { fetch_key_block_with_next_validators_by_seqno, get_blockchain_query_client, get_random_uint_64, fetch_block_and_transaction_by_seqno, get_recent_proper_key_blocks, fetch_block, LSPair } from "../scripts/utils";


/*

This script contains tests for lite-client & transaction-checker contracts.
It fetches testnet transactions and blocks and proves their existance to the contracts mentioned above.
Basically, it is Testnet->Testnet "bridge" that attests proofs of presence of blocks and transactions.
This is equivalent to Testnet->Fastnet and Fastnet->Testnet, because the validation logic remains the
same regardless of these two networks.

*/


describe("TonBridgeContest", () => {
    beforeAll(async () => {
        await compile("TonBridgeContest");
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let lite_client_contract: SandboxContract<LiteClientContract>;
    let transaction_checker_contract: SandboxContract<TransactionCheckerContract>;
    let testnet_ls_pair: LSPair;
    let fastnet_ls_pair: LSPair;

    // seqnos of key_blocks with included 36th param (new validators)
    let testnet_proper_key_blocks_seqnos: number[] = [];
    // let fastnet_proper_key_blocks_seqnos: number[] = [];

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        
        testnet_ls_pair = await get_blockchain_query_client("testnet");
        fastnet_ls_pair = await get_blockchain_query_client("fastnet");
        
        testnet_proper_key_blocks_seqnos = await get_recent_proper_key_blocks(testnet_ls_pair);
        // fastnet_proper_key_blocks_seqnos = await get_recent_proper_key_blocks(fastnet_ls_pair);

        lite_client_contract = blockchain.openContract(await LiteClientContract.createFromConfig(testnet_ls_pair, testnet_proper_key_blocks_seqnos[0]));
        transaction_checker_contract = blockchain.openContract(await TransactionCheckerContract.createFromConfig(lite_client_contract.address));

        deployer = await blockchain.treasury("deployer");

        const deployResult = await lite_client_contract.sendDeployLiteClient(deployer.getSender(), testnet_ls_pair, testnet_proper_key_blocks_seqnos[0], toNano("0.1"));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: lite_client_contract.address,
            deploy: true,
            success: true,
        });

    }, 500000);

    async function get_validators_info() {
        const current_validators_info = (await blockchain.runGetMethod(lite_client_contract.address, "get_validators_info", [])).stackReader;
        const current_validators_utime_until = Number(current_validators_info.readBigNumber());
        const current_validators_total_weight = current_validators_info.readBigNumber();
        const current_validators = current_validators_info.readCell();
        const next_validators_utime_until = Number(current_validators_info.readBigNumber());
        const next_validators_total_weight = current_validators_info.readBigNumber();
        const next_validators = current_validators_info.readCell();
        const latest_known_epoch_block_seqno = Number(current_validators_info.readBigNumber());
        return { current_validators_utime_until, current_validators_total_weight, current_validators,
                 next_validators_utime_until,    next_validators_total_weight,    next_validators,  latest_known_epoch_block_seqno };
    }

    afterAll(() => {
        testnet_ls_pair.engine.close();
    }, 1000);

    it("should deploy", async () => {
        // the check is done inside beforeEach
        // blockchain and TonBridgeContest are ready to use
    }, 500000);

    it(`should call new_key_block on a chain of ${testnet_proper_key_blocks_seqnos.length - 1} valid keyblocks`, async () => {
        let arbitrary_sender = await blockchain.treasury("Alice", { balance: toNano("10") });

        let latest_known_epoch_key_block_seqno = (await get_validators_info()).latest_known_epoch_block_seqno;

        for (let i = 1; i <= testnet_proper_key_blocks_seqnos.length - 1; i++) {
            const key_block = await fetch_key_block_with_next_validators_by_seqno(testnet_ls_pair, testnet_proper_key_blocks_seqnos[i]);
            const some_query_id = get_random_uint_64();
            const test_new_key_block = await lite_client_contract.sendNewKeyBlock(arbitrary_sender.getSender(), some_query_id, { block: key_block.block, file_hash: key_block.file_hash, signatures: key_block.block_signatures });

            expect(test_new_key_block.transactions).toHaveTransaction({
                from: lite_client_contract.address,
                to: arbitrary_sender.address,
                exitCode(x) {
                    if (x !== 0) {
                        console.log("TVM terminated with exitCode", x);
                        return false;
                    }
                    return true;
                },
                body: (x: Cell | undefined) => {
                    if (x) {
                        const response_message = x.asSlice();
                        const correct_prefix = response_message?.loadUintBig(32) === 0xff8ff4e1n;
                        const correct_query_id = response_message?.loadUintBig(64) === some_query_id;
                        expect(correct_prefix && correct_query_id).toBe(true);
                        console.log(`Successfully updated contract's state via valid key_block [${i + 1}]`);
                        return correct_prefix && correct_query_id;
                    }
                    console.log("Failed. Result: ", test_new_key_block);
                    return false;
                },
            });

            const new_latest_known_epoch_key_block_seqno = (await get_validators_info()).latest_known_epoch_block_seqno;

            expect(latest_known_epoch_key_block_seqno).toBeLessThan(new_latest_known_epoch_key_block_seqno);

            latest_known_epoch_key_block_seqno = new_latest_known_epoch_key_block_seqno;
        }
    }, 500000);

    it("should call check_block on 10 random blocks from currently known epoch", async () => {
        let arbitrary_sender = await blockchain.treasury("Bob", { balance: toNano("10") });

        const validators_info = (await blockchain.runGetMethod(lite_client_contract.address, "get_validators_info", [])).stackReader;
        const current_validators_utime_until = Number(validators_info.readBigNumber());
        const current_validators_total_weight = validators_info.readBigNumber();
        const current_validators = Dictionary.loadDirect(Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(45), validators_info.readCell());
        const next_validators_utime_until = Number(validators_info.readBigNumber());
        const next_validators_total_weight = validators_info.readBigNumber();
        const next_validators = Dictionary.loadDirect(Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(45), validators_info.readCell());

        for (let i = 0; i < 10; i++) {
            const epoch_first_block_seqno = (await testnet_ls_pair.client.lookupBlockByUtime({workchain: -1, shard: "-9223372036854775808", utime: current_validators_utime_until - 100})).id.seqno;
            const epoch_last_block_seqno = (await testnet_ls_pair.client.lookupBlockByUtime({workchain: -1, shard: "-9223372036854775808", utime: current_validators_utime_until})).id.seqno;
            const seqno_between = Number(((Math.random() * (epoch_last_block_seqno - epoch_first_block_seqno)) + epoch_first_block_seqno).toFixed(0));
            const arbitrary_block = await fetch_block(testnet_ls_pair, seqno_between, current_validators_total_weight, current_validators, next_validators_total_weight, next_validators);
            const some_query_id = get_random_uint_64();
            if (arbitrary_block.weak_signatures_from_archival_node) {
                console.log(`Could not retrieve signatures with stronger signers for block seqno=${arbitrary_block.seqno}, because it's too old and proper state has been gc'd. Continuing silently...`);
                continue;
            }
            // @ts-ignore
            const test_check_block = await lite_client_contract.sendCheckMcBlock(arbitrary_sender.getSender(), some_query_id, { block: arbitrary_block.block, file_hash: arbitrary_block.file_hash, signatures: arbitrary_block.block_signatures, do_validators_switch_for_check_block: arbitrary_block.do_validators_switch_for_check_block });

            expect(test_check_block.transactions).toHaveTransaction({
                from: lite_client_contract.address,
                to: arbitrary_sender.address,
                exitCode(x) {
                    if (x !== 0) {
                        console.log("exitCode", x);
                        return false;
                    }
                    return true;
                },
                success: true,
                body: (x: Cell | undefined) => {
                    if (x) {
                        const response_message = x.asSlice();
                        const correct_prefix = response_message?.loadUintBig(32) === 0xce02b807n;
                        const correct_query_id = response_message?.loadUintBig(64) === some_query_id;
                        expect(correct_prefix && correct_query_id).toBe(true);
                        console.log(`Successfully checked randomly chosen block with seqno=${arbitrary_block.seqno} via contract's state`);
                        return correct_prefix && correct_query_id;
                    }
                    console.log("Failed. Result: ", test_check_block);
                    return false;
                },
            });
        }
    }, 500000);

    it("should call new_key_block and fail due to faulty signature", async () => {
        let arbitrary_sender = await blockchain.treasury("Craig", { balance: toNano("10") });

        const some_query_id = get_random_uint_64();

        const key_block = await fetch_key_block_with_next_validators_by_seqno(testnet_ls_pair, testnet_proper_key_blocks_seqnos[testnet_proper_key_blocks_seqnos.length - 1]);
        let tampered_signatures = key_block.block_signatures;

        // Corrupting signature by changing one arbitrary byte

        let signature_keys = Array.from(tampered_signatures.keys());
        const random_signature_key = signature_keys[Number((Math.random() * (signature_keys.length - 1)).toFixed(0))];
        let random_signature_value = tampered_signatures.get(random_signature_key)!;
        const random_signature_value_random_byte_index = Number((Math.random() * 64).toFixed(0));
        let random_signature_value_random_byte = random_signature_value[random_signature_value_random_byte_index];
        random_signature_value.set([random_signature_value_random_byte ^ 0x10], random_signature_value_random_byte_index);
        tampered_signatures.set(random_signature_key, random_signature_value);

        const test_new_key_block_attempt = await lite_client_contract.sendNewKeyBlock(arbitrary_sender.getSender(), some_query_id, { block: key_block.block, file_hash: key_block.file_hash, signatures: tampered_signatures });

        expect(test_new_key_block_attempt.transactions).toHaveTransaction({
            on: lite_client_contract.address,
            to: lite_client_contract.address,
            exitCode: 104 // errors::faulty_signature
        });

        console.log("Successfully failed due to faulty signature");
    }, 500000);

    it("should call new_key_block on an outdated key block from previous epoch", async () => {
        let arbitrary_sender = await blockchain.treasury("Craig", { balance: toNano("10") });

        const some_query_id = get_random_uint_64();

        // Getting first key_block which is completely valid, but outdated

        const key_block = await fetch_key_block_with_next_validators_by_seqno(testnet_ls_pair, testnet_proper_key_blocks_seqnos[0]);

        const test_new_key_block_attempt = await lite_client_contract.sendNewKeyBlock(arbitrary_sender.getSender(), some_query_id, { block: key_block.block, file_hash: key_block.file_hash, signatures: key_block.block_signatures });

        expect(test_new_key_block_attempt.transactions).toHaveTransaction({
            on: lite_client_contract.address,
            to: lite_client_contract.address,
            exitCode: 109 // errors::expected_known_epoch_block
        });

        console.log(`Successfully failed due to valid, but outdated key block`);
    }, 500000);
});
