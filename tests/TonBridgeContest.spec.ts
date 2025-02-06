import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { beginCell, Cell, Dictionary, toNano } from "@ton/core";
import { LiteClientContract, TransactionCheckerContract } from "../wrappers/TonBridgeContest";
import "@ton/test-utils";
import { compile } from "@ton/blueprint";
import { fetch_key_block_with_next_validators_by_seqno, get_blockchain_query_client, get_random_uint_64, fetch_block_and_transaction_by_seqno, get_recent_proper_key_blocks, fetch_block, LSPair } from "../scripts/utils";


/*

   This script contains tests for lite-client & transaction-checker contracts.
It fetches testnet transactions and blocks and proves their existance to the contracts mentioned above.
Since, masterchain signatures are cleared quickly from validator's memory (and we demand >1 key blocks
and therefore >1 signatures), this file contains a Testnet->Testnet "bridge" that attests proofs of
presence of blocks and transactions in testnet. This is equivalent to Testnet->Fastnet and
Fastnet->Testnet, because the validation logic remains the same regardless of these two networks.

   For Fastnet->Testnet (validation of Fastnet information inside Testnet) use testnet-cli.

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

    // seqnos of key_blocks with included 36th param (new validators)
    let testnet_proper_key_blocks_seqnos: number[] = [];

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        
        testnet_ls_pair = await get_blockchain_query_client("testnet");

        testnet_proper_key_blocks_seqnos = await get_recent_proper_key_blocks(testnet_ls_pair, 5);
        
        const lite_client_contract_from_config = await LiteClientContract.createFromConfig(testnet_ls_pair, testnet_proper_key_blocks_seqnos[0]);
        lite_client_contract = blockchain.openContract(lite_client_contract_from_config);
        
        deployer = await blockchain.treasury("deployer");
        
        const lite_client_deploy_result = await lite_client_contract.sendDeployLiteClient(deployer.getSender(), lite_client_contract_from_config.init!.data, testnet_proper_key_blocks_seqnos[0], toNano("0.1"));
        
        expect(lite_client_deploy_result.transactions).toHaveTransaction({
            from: deployer.address,
            to: lite_client_contract.address,
            deploy: true,
            success: true,
        });
        
        transaction_checker_contract = blockchain.openContract(await TransactionCheckerContract.createFromConfig(lite_client_contract.address));
        const transaction_checker_contract_deploy_result = await transaction_checker_contract.sendDeployTransactionChecker(deployer.getSender(), lite_client_contract.address, toNano("0.1"));

        expect(transaction_checker_contract_deploy_result.transactions).toHaveTransaction({
            from: deployer.address,
            to: transaction_checker_contract.address,
            deploy: true,
            success: true,
        });

    }, 500000);

    async function get_validators_info() {
        const current_validators_info = (await blockchain.runGetMethod(lite_client_contract.address, "get_validators_info", [])).stackReader;
        const current_validators_utime_until = Number(current_validators_info.readBigNumber());
        const current_validators_total_weight = current_validators_info.readBigNumber();
        const current_validators_raw_dict = current_validators_info.readCell();
        const next_validators_utime_until = Number(current_validators_info.readBigNumber());
        const next_validators_total_weight = current_validators_info.readBigNumber();
        const next_validators_raw_dict = current_validators_info.readCell();
        const latest_known_epoch_block_seqno = Number(current_validators_info.readBigNumber());
        
        const current_validators = Dictionary.loadDirect(Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(45), current_validators_raw_dict);
        const next_validators = Dictionary.loadDirect(Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(45), next_validators_raw_dict);

        return { current_validators_utime_until, current_validators_total_weight, current_validators,
                 next_validators_utime_until,    next_validators_total_weight,    next_validators,  latest_known_epoch_block_seqno };
    }

    afterAll(() => {
        testnet_ls_pair.engine.close();
        testnet_ls_pair.engine.close();
    }, 1000);

    it("should deploy", async () => {
        // the check is done inside beforeEach
        // blockchain and TonBridgeContest are ready to use
    }, 500000);

    it(`should call new_key_block on a chain of valid keyblocks`, async () => {
        let arbitrary_sender = await blockchain.treasury("Alice", { balance: toNano("10") });

        let latest_known_epoch_key_block_seqno = (await get_validators_info()).latest_known_epoch_block_seqno;

        for (let i = 1; i < testnet_proper_key_blocks_seqnos.length; i++) {
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

    it(`should call check_transaction`, async () => {
        let arbitrary_sender = await blockchain.treasury("Alice", { balance: toNano("10") });

        const validators_info = await get_validators_info();
        const latest_known_epoch_key_block_seqno = validators_info.latest_known_epoch_block_seqno;

        const seqno = latest_known_epoch_key_block_seqno + 1;
        const block = await fetch_block_and_transaction_by_seqno(testnet_ls_pair, seqno, validators_info.current_validators_total_weight, validators_info.current_validators, validators_info.next_validators_total_weight, validators_info.next_validators);

        // @ts-ignore
        const test_check_transaction = await transaction_checker_contract.sendCheckTransactionInMcBlock(arbitrary_sender.getSender(), { block: block.block, signatures: block.block_signatures, file_hash: block.file_hash, account_dict_key: block.account_dict_key, transaction_dict_key: block.transaction_dict_key, transaction_cell: block.transaction_cell, do_validators_switch_for_check_block: block.do_validators_switch_for_check_block });

        expect(test_check_transaction.transactions).toHaveTransaction({
            from: transaction_checker_contract.address,
            to: arbitrary_sender.address,
            success: true,
            body: (x: Cell | undefined) => {
                if (x) {
                    const response_message = x.asSlice();
                    const correct_prefix = response_message?.loadUintBig(32) === 0x756adff1n;
                    expect(correct_prefix).toBe(true);
                    console.log(`Successfully checked transaction in block with seqno=${seqno}`);
                    return correct_prefix;
                }
                console.log("Failed. Result: ", test_check_transaction);
                return false;
            }
        });
    }, 500000);

    it(`should call check_transaction on tampered transaction and fail`, async () => {
        let arbitrary_sender = await blockchain.treasury("Mallory", { balance: toNano("10") });

        const validators_info = await get_validators_info();
        const latest_known_epoch_key_block_seqno = validators_info.latest_known_epoch_block_seqno;

        const seqno = latest_known_epoch_key_block_seqno + 1;
        const block = await fetch_block_and_transaction_by_seqno(testnet_ls_pair, seqno, validators_info.current_validators_total_weight, validators_info.current_validators, validators_info.next_validators_total_weight, validators_info.next_validators);

        const test_check_transaction = await transaction_checker_contract.sendCheckTransactionInMcBlock(arbitrary_sender.getSender(), { block: block.block, signatures: block.block_signatures, file_hash: block.file_hash, account_dict_key: block.account_dict_key, transaction_dict_key: block.transaction_dict_key ^ 0x10n, transaction_cell: block.transaction_cell, do_validators_switch_for_check_block: block.do_validators_switch_for_check_block });

        expect(test_check_transaction.transactions).toHaveTransaction({
            on: transaction_checker_contract.address,
            to: transaction_checker_contract.address,
            exitCode: 110
        });
    }, 500000);

    it(`should call check_transaction on tampered account and fail`, async () => {
        let arbitrary_sender = await blockchain.treasury("Mallory", { balance: toNano("10") });

        const validators_info = await get_validators_info();
        const latest_known_epoch_key_block_seqno = validators_info.latest_known_epoch_block_seqno;

        const seqno = latest_known_epoch_key_block_seqno + 1;
        const block = await fetch_block_and_transaction_by_seqno(testnet_ls_pair, seqno, validators_info.current_validators_total_weight, validators_info.current_validators, validators_info.next_validators_total_weight, validators_info.next_validators);

        const test_check_transaction = await transaction_checker_contract.sendCheckTransactionInMcBlock(arbitrary_sender.getSender(), { block: block.block, signatures: block.block_signatures, file_hash: block.file_hash, account_dict_key: block.account_dict_key ^ 0x10n, transaction_dict_key: block.transaction_dict_key, transaction_cell: block.transaction_cell, do_validators_switch_for_check_block: block.do_validators_switch_for_check_block });

        expect(test_check_transaction.transactions).toHaveTransaction({
            on: transaction_checker_contract.address,
            to: transaction_checker_contract.address,
            exitCode: 110
        });
    }, 500000);

    it(`should call check_transaction on tampered block and fail`, async () => {
        let arbitrary_sender = await blockchain.treasury("Mallory", { balance: toNano("10") });

        const validators_info = await get_validators_info();
        const latest_known_epoch_key_block_seqno = validators_info.latest_known_epoch_block_seqno;

        const seqno = latest_known_epoch_key_block_seqno + 1;
        const block = await fetch_block_and_transaction_by_seqno(testnet_ls_pair, seqno, validators_info.current_validators_total_weight, validators_info.current_validators, validators_info.next_validators_total_weight, validators_info.next_validators);

        let block_cs = block.block.asSlice();
        let modified_block = beginCell();
        modified_block.storeUint(block_cs.loadUint(32) ^ 0x10, 32);  // Tampered Block prefix! This will cause signatures check fail (error 104)
        modified_block.storeUint(block_cs.loadUint(32), 32);  // global_id
        modified_block.storeRef(block_cs.loadRef());  // info
        modified_block.storeRef(block_cs.loadRef());  // value_flow
        modified_block.storeRef(block_cs.loadRef());  // state_update
        modified_block.storeRef(block_cs.loadRef());  // extra

        const test_check_transaction = await transaction_checker_contract.sendCheckTransactionInMcBlock(arbitrary_sender.getSender(), { block: modified_block.endCell(), signatures: block.block_signatures, file_hash: block.file_hash, account_dict_key: block.account_dict_key, transaction_dict_key: block.transaction_dict_key, transaction_cell: block.transaction_cell, do_validators_switch_for_check_block: block.do_validators_switch_for_check_block });
        
        expect(test_check_transaction.transactions).toHaveTransaction({
            on: lite_client_contract.address,
            exitCode: 104
        });

        expect(test_check_transaction.transactions).toHaveTransaction({
            on: transaction_checker_contract.address,
            to: transaction_checker_contract.address,
            exitCode: 113
        });
    }, 500000);
});
