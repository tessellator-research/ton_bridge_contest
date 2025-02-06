import { beginCell, Cell, Dictionary, Slice } from "@ton/core";
import { Functions } from "ton-lite-client/dist/schema";
import { liteServer_BlockData } from "ton-lite-client/dist/schema";
import { TonRocks, ParsedBlock } from "@oraichain/tonbridge-utils";
import { LiteClient, LiteRoundRobinEngine, LiteSingleEngine, LiteEngine } from "ton-lite-client";
import { signVerify } from "@ton/crypto";
import { parse_hashmap_aug } from "./hashmapaug";
import { read_raw_mc_block, read_signatures, save_raw_mc_block, save_signatures } from "./cache";
import { promises as fs } from "fs";
import { exit } from "process";

export type LSPair = { engine: LiteEngine, client: LiteClient, network: "testnet" | "fastnet" };

export async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, 1000));
}

export function uint8array_to_hex(buffer: Uint8Array): string {
    return Array.prototype.map.call(buffer, (x) => ("00" + x.toString(16)).slice(-2)).join("");
}

export function hex_to_uint8array(hex: string): Uint8Array {
    return Uint8Array.from(Buffer.from(hex, "hex"));
}

export function get_random_uint_64(): bigint {
    let buff = new Uint8Array(8);
    crypto.getRandomValues(buff);
    return BigInt("0x" + uint8array_to_hex(buff));
}

function int_to_ip(int: number): string {
    var part1 = int & 255;
    var part2 = (int >> 8) & 255;
    var part3 = (int >> 16) & 255;
    var part4 = (int >> 24) & 255;

    return part4 + "." + part3 + "." + part2 + "." + part1;
}

export function generate_validators_cell(validators: any) {
    let idx = 0;
    function continue_cell() {
        let cell = beginCell();
        for (let i = 0; i < 3 && idx < validators.length; i++, idx++) {
            cell.storeUint(validators[idx][0], 256).storeUint(validators[idx][1], 64);
        }
        if (idx < validators.length) {
            cell.storeRef(continue_cell());
        }
        return cell.endCell();
    }
    return continue_cell();
}

export function generate_signatures_cell(signatures: any) {
    let idx = 0;
    function continue_cell() {
        let cell = beginCell();
        for (let i = 0; i < 1 && idx < signatures.length; i++, idx++) {
            cell.storeUint(signatures[idx][0], 8).storeBuffer(signatures[idx][1], 64);
        }
        if (idx < signatures.length) {
            cell.storeRef(continue_cell());
        }
        return cell.endCell();
    }
    return continue_cell();
}

export async function get_blockchain_query_client(network: string): Promise<LSPair> {
    let liteservers = [];
    if (network === "testnet") {
        const result = (await fetch("https://ton.org/testnet-global.config.json").then((data) => data.json()));
        liteservers = result.liteservers;
    } else if (network === "fastnet") {
        const result = (await fetch("https://contest.com/file/400780400604/4/P0UeFR_X1mg.1626.json/04de18101ec5af6dea").then((data) => data.json()));
        liteservers = result.liteservers;
    } else {
        throw new Error(`Unknown network name "${network}"`);
    }
    const engines: LiteEngine[] = [];
    engines.push(...liteservers.map((server: any) => new LiteSingleEngine({ host: `tcp://${int_to_ip(server.ip)}:${server.port}`, publicKey: Buffer.from(server.id.key, "base64") })));
    const engine = new LiteRoundRobinEngine(engines);
    return { engine: engine, client: new LiteClient({ engine }), network };
}

export async function parse_block(block: liteServer_BlockData): Promise<ParsedBlock> {
    const [rootCell] = await TonRocks.types.Cell.fromBoc(block.data);
    const rootHash = Buffer.from(rootCell.hashes[0]).toString("hex");
    if (rootHash !== block.id.rootHash.toString("hex")) {
        throw Error("got wrong block or here was a wrong root_hash format");
    }
    const parsedBlock = TonRocks.bc.BlockParser.parseBlock(rootCell);
    return parsedBlock;
}

export async function get_node_id_short(pubkey: Buffer) {
    return Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.concat([Buffer.from([0xc6, 0xb4, 0x13, 0x48]), pubkey]))).toString("base64");
}

export async function get_recent_proper_key_blocks(ls_pair: LSPair, quantity=5) {
    console.log("Getting recent key blocks with new validators...")
    const mc_info = (await ls_pair.client.getMasterchainInfo()).last;
    const mc_seqno = mc_info.seqno;
    const mc_root_hash = mc_info.rootHash;
    const mc_file_hash = mc_info.fileHash;
    const parsed_mc_block = await parse_block_raw(await get_block_raw(ls_pair, mc_seqno, mc_root_hash, mc_file_hash, -1, "-9223372036854775808"));
    let last_key_block_seqno = parsed_mc_block.info.prev_key_block_seqno;
    let proper_blocks_seqnos = [];
    while (proper_blocks_seqnos.length < quantity) {
        await sleep(150);
        const block_i = await get_mc_block_by_seqno(ls_pair, last_key_block_seqno);
        if (block_i.extra.custom.config.config.map.get("24")) {
            proper_blocks_seqnos.push(block_i.info.seq_no);
        }
        last_key_block_seqno = block_i.info.prev_key_block_seqno;
    }
    return proper_blocks_seqnos.sort();
}

export async function get_block_signatures(ls_pair: LSPair, seqno: number, prevent_caching: boolean = false, attempts = 0): Promise<any | null> {
    let data = await read_signatures(seqno);
    if (data) {
      console.log(`Fetched signatures of block with seqno=${seqno} from cache`);
      const signatures = data.result.signatures.map((signature_obj: any) => { return { node_id_short: signature_obj.node_id_short, signature: Buffer.from(signature_obj.signature, "base64") } });
      return { signatures, workchain: data.result.id.workchain, shard: data.result.id.shard, root_hash: data.result.id.root_hash, file_hash: data.result.id.file_hash };
    }
    let url = `https://testnet.toncenter.com/api/v2/getMasterchainBlockSignatures?api_key=a3c813fe0a5607b28f259c5bd9941db91ce8275a5998dab85498827dad9bd7c2&seqno=${seqno}`;
    if (ls_pair.network === "fastnet") {
        url = `http://109.236.91.95:8081/getMasterchainBlockSignatures?seqno=${seqno}`;
    }

    const response = await fetch(url);
    if (response.ok) {
        const data = await response.json();
        const signatures = data.result.signatures.map((signature_obj: any) => { return { node_id_short: signature_obj.node_id_short, signature: Buffer.from(signature_obj.signature, "base64") } });
        if (signatures.length === 0) {
            throw new Error(`[get_block_signatures] no signatures found for block with seqno=${seqno}`);
        }
        if (!prevent_caching) {
          await save_signatures(data, seqno);
        }
        return { signatures, workchain: data.result.id.workchain, shard: data.result.id.shard, root_hash: data.result.id.root_hash, file_hash: data.result.id.file_hash };
    } else if (response.status === 500) {
        console.log(`Trying to get block signatures once again... seqno=${seqno}`);
        await sleep(150);
        return get_block_signatures(ls_pair, seqno, prevent_caching, attempts + 1);
    } else {
        throw new Error(`[get_block_signatures] HTTP error status: ${response.status}\nResponse: ${response.statusText}`);
    }
}

export async function get_block_root_and_file_hashes(ls_pair: LSPair, seqno: number, workchain: number, shard: string) {
    const result = (await ls_pair.client.getFullBlock(seqno)).shards.filter((shard_) => shard_.shard === shard && shard_.workchain === workchain)[0];
    return { root_hash: result.rootHash, file_hash: result.fileHash };
}

export async function get_mc_block_by_seqno(ls_pair: LSPair, seqno: number, prevent_caching: boolean = false) {
    const { root_hash, file_hash } = await get_block_root_and_file_hashes(ls_pair, seqno, -1, "-9223372036854775808");
    return await parse_block_raw(await get_block_raw(ls_pair, seqno, root_hash, file_hash, -1, "-9223372036854775808", prevent_caching));
}

export async function get_block_raw(ls_pair: LSPair, seqno: number, root_hash: Buffer, file_hash: Buffer, workchain: number, shard: string, prevent_caching: boolean = false) {
    const cached_block = await read_raw_mc_block(seqno, workchain, shard);
    if (cached_block) {
      console.log(`Fetched block with seqno=${seqno} from cache`);
      return cached_block;
    }
    const result = (await ls_pair.engine.query(Functions.liteServer_getBlock, {
        kind: "liteServer.getBlock",
        id: {
            kind: "tonNode.blockIdExt",
            workchain: workchain,
            shard: shard,
            seqno: seqno,
            rootHash: root_hash,
            fileHash: file_hash
        },
    })).data;
    if (!prevent_caching) {
      await save_raw_mc_block(result, seqno, workchain, shard);
    }
    return result;
}

export async function parse_block_raw(block_raw: Buffer) {
    const [root_cell] = await TonRocks.types.Cell.fromBoc(block_raw);
    return TonRocks.bc.BlockParser.parseBlock(root_cell);
}

export function remove_most_significant_signers(validators: any, subset: bigint[], total_weight: bigint): bigint[] {
    let sorted_subset = subset.sort((i: bigint, j: bigint) => {
        const weight_i = BigInt("0x" + uint8array_to_hex(validators.get(i)!.slice(5 + 32, 5 + 32 + 8)));
        const weight_j = BigInt("0x" + uint8array_to_hex(validators.get(j)!.slice(5 + 32, 5 + 32 + 8)));
        return (weight_i < weight_j) ? -1 : (
            (weight_i === weight_j) ? 0 : 1
        );
    }).map((i: bigint) => [i, BigInt("0x" + uint8array_to_hex(validators.get(i)!.slice(5 + 32, 5 + 32 + 8)))]);

    let significant = [];
    do {
        significant.push(sorted_subset.pop()![0]);
    } while (sorted_subset.reduce((a, c) => a + c[1], 0n) * 3n > total_weight);
    return significant;
}

export async function fetch_block_and_transaction_by_seqno(ls_pair: LSPair, seqno: number, current_validators_total_weight: bigint, current_validators_dict: any, next_validators_total_weight: bigint, next_validators_dict: any, tx_hash: bigint = 0n) {
    const { signatures, workchain, shard } = (await get_block_signatures(ls_pair, seqno))!;

    const root_file_hashes = (await get_block_root_and_file_hashes(ls_pair, seqno, workchain, shard))!;
    const root_hash = root_file_hashes.root_hash;
    const file_hash = root_file_hashes.file_hash;
    const block_raw = (await get_block_raw(ls_pair, seqno, root_hash, file_hash, workchain, shard))!;
    
    const block_cell = Cell.fromBoc(block_raw)[0];
    
    let transaction_cell = Cell.EMPTY;
    let account_dict_key = -1n;
    let transaction_dict_key = -1n;
    
    const block_parsed = (await parse_block_raw(block_raw))!;

    if (tx_hash === 0n) {
        // Fetching random transaction if not specified.
        const account_blocks = Array.from(block_parsed.extra.account_blocks.map.values());
        const random_account_block = account_blocks[Number((Math.random() * (account_blocks.length - 1)).toFixed(0))];
        // @ts-ignore
        const random_account_block_transactions = Array.from(random_account_block.value.transactions.map.values());
        const random_transaction = random_account_block_transactions[Number((Math.random() * (random_account_block_transactions.length - 1)).toFixed(0))];
        // @ts-ignore
        tx_hash = BigInt("0x" + uint8array_to_hex(await random_transaction.value.cell.hash(0)));
    }

    {
        const block_cs = block_cell.asSlice().clone();
        block_cs.loadUint(32);
        block_cs.loadUint(32);
        block_cs.loadRef(); // info
        block_cs.loadRef(); // value_flow
        block_cs.loadRef(); // state_update
        const extra_cs = block_cs.loadRef().asSlice(); // extra
        extra_cs.loadUint(32);
        extra_cs.loadRef();
        extra_cs.loadRef();

        const account_blocks_cs = extra_cs.loadRef().asSlice();
        if (account_blocks_cs.loadBit()) {
            const account_blocks = parse_hashmap_aug(account_blocks_cs.loadRef().beginParse(), 256);
            for (let account_block_entry of account_blocks.entries()) {
                let account_block_cs = account_block_entry[1];
                account_block_cs.loadBits(4 + 256 + 4);
                const transactions = parse_hashmap_aug(account_block_cs, 64);
                for (let transaction_entry of transactions.entries()) {
                    let transaction_cs = transaction_entry[1];
                    let transaction_ref_cs = transaction_cs.loadRef().asSlice();
                    if (transaction_ref_cs.preloadUint(4) == 7) {
                        if (BigInt("0x" + transaction_ref_cs.asCell().hash().toString("hex")) == tx_hash) {
                            transaction_cell = transaction_ref_cs.asCell();
                            account_dict_key = account_block_entry[0];
                            transaction_dict_key = transaction_entry[0];
                            break;
                        }
                    }
                }
            }
        }
    }

    {
        // Sanity checks

        if (transaction_dict_key === -1n) {
            throw new Error(`Transaction with hash ${tx_hash.toString(16)} not found in block with seqno=${seqno}`);
        }
        if (block_parsed.info.not_master) {
            throw new Error(`Not master block!`);
        }
    }

    let block_signatures_dict_serialized = Dictionary.empty(
        Dictionary.Keys.BigUint(16),
        Dictionary.Values.Buffer(64),
    );

    let do_validators_switch_for_check_block = false;
    
    {
        let coincided_node_id_shorts = 0;
        for (let i = 0; i < signatures.length; i++) {
            const node_id_short_i = signatures[i].node_id_short;
            for (let j = 0; j < current_validators_dict.size; j++) {
                const current_validators_dict_j = current_validators_dict.get(BigInt(j));
                const pubkey_j = current_validators_dict_j.slice(5, 5 + 32);
                const node_id_short_j = await get_node_id_short(pubkey_j);
                if (node_id_short_i === node_id_short_j) {
                    coincided_node_id_shorts++;
                    break;
                }
            }
        }

        if (coincided_node_id_shorts < signatures.length) {
            console.log("Making a switch!", coincided_node_id_shorts);
            do_validators_switch_for_check_block = true;
            current_validators_dict = next_validators_dict;
            current_validators_total_weight = next_validators_total_weight;
        }
    }

    {
        // Signatures check

        const message = Buffer.concat([
            Buffer.from([0x70, 0x6e, 0x0b, 0xc5]),
            root_hash!,
            file_hash!,
        ]);

        let signed_weight = 0n;

        for (let i = 0; i < signatures.length; i++) {
            const node_id_short_i = signatures[i].node_id_short;
            for (let j = 0; j < current_validators_dict.size; j++) {
                const current_validators_dict_j = current_validators_dict.get(BigInt(j));
                const pubkey_j = current_validators_dict_j.slice(5, 5 + 32);
                const weight_j = current_validators_dict_j.slice(5 + 32, 5 + 32 + 8);
                const node_id_short_j = await get_node_id_short(pubkey_j);
                if (node_id_short_i === node_id_short_j) {
                    if (!signVerify(message, signatures[i].signature, pubkey_j)) {
                        throw new Error(`Invalid signature! ${i} ${j}`);
                    }
                    block_signatures_dict_serialized.set(BigInt(j), signatures[i].signature);
                    signed_weight += BigInt("0x" + uint8array_to_hex(weight_j));
                    break;
                }
            }
        }

        if (signed_weight * 3n <= current_validators_total_weight * 2n) {
            if (signed_weight === 0n) {
              throw new Error("Block signers is not a subset of current validators");
            }
            console.log(`Weak signers! ${signed_weight}/${current_validators_total_weight}; seqno=${seqno}; block_signatures_dict_serialized.size=${block_signatures_dict_serialized.size} signatures_quantity=${signatures.length}`);
            // let kt_weight = 0n; for (let k = 0; k < actual_validators_dict.size; k++) { kt_weight += BigInt("0x" + uint8array_to_hex(actual_validators_dict.get(BigInt(k))![1].slice(5 + 32, 5 + 32 + 8))); }
            // block_signatures_dict_serialized.keys().map((k: bigint) => { console.log(`pubkey=${uint8array_to_hex(actual_validators_dict.get(k)![1].slice(5, 5 + 32))}; weight=${BigInt("0x" + uint8array_to_hex(actual_validators_dict.get(k)![1].slice(5 + 32, 5 + 32 + 8)))}`); });
            // console.log(`ALL_WEIGHT=${kt_weight}`);
            console.log("Trying to get signatures with stronger signers...");
            // There's a chance of lite server returning signatures from underpowered signers. In this case
            // we try to obtain a signature set with stronger signers by querying the lite server once again.
            return await fetch_block_and_transaction_by_seqno(ls_pair, seqno, current_validators_total_weight, current_validators_dict, next_validators_total_weight, next_validators_dict, tx_hash);
        }
    }

    console.log(`Successfully got valid block (seqno=${seqno}) containing transaction with hash ${tx_hash.toString(16)}`);

    return {
        block: block_cell,
        file_hash: BigInt("0x" + uint8array_to_hex(file_hash!)),
        block_signatures: block_signatures_dict_serialized,

        account_dict_key,
        transaction_dict_key,
        transaction_cell,
        do_validators_switch_for_check_block
    }
}

function equal_pubkeys(arr1: Uint8Array, arr2: Uint8Array): boolean {
    return arr1.every((value, index) => value === arr2[index]);
}

export async function fetch_key_block_with_next_validators_by_seqno(ls_pair: LSPair, seqno: number) {
    const { root_hash, file_hash } = (await get_block_root_and_file_hashes(ls_pair, seqno, -1, "-9223372036854775808"))!;
    const block_raw = (await get_block_raw(ls_pair, seqno, root_hash, file_hash, -1, "-9223372036854775808"))!;

    const block_cell = Cell.fromBoc(block_raw)[0];

    const { signatures } = (await get_block_signatures(ls_pair, seqno))!;
    const block_parsed = (await parse_block_raw(block_raw))!;

    {
        // Sanity checks

        if (!block_parsed.info.key_block) {
            throw new Error(`Not a key block!`);
        }
        if (!block_parsed.extra.custom.config.config.map.get("24")) {
            throw new Error(`Does not contain new validators!`);
        }
        const root_hash_prime = block_cell.hash().toString("hex");
        if (root_hash_prime !== root_hash.toString("hex")) {
            throw new Error(`Root hashes are not equal! ${root_hash_prime} != ${root_hash.toString("hex")}`);
        }
    }

    let current_validators = (Array.from(block_parsed.extra.custom.config.config.map.get("22").cur_validators.list.map.entries()) as any).sort((a: any, b: any) => a[0] - b[0] < 0 ? -1 : 1).map((validator: any) => validator[1]);
    for (let i = 0; i < current_validators.length; i++) {
      current_validators[i].node_id_short = await get_node_id_short(current_validators[i].public_key.pubkey);
    }
    const current_validators_total_weight = BigInt(block_parsed.extra.custom.config.config.map.get("22").cur_validators.total_weight.toString(10));

    let block_signatures_dict_serialized = Dictionary.empty(
        Dictionary.Keys.BigUint(16),
        Dictionary.Values.Buffer(64),
    );

    {
        // Signatures check

        const message = Buffer.concat([
            Buffer.from([0x70, 0x6e, 0x0b, 0xc5]),
            root_hash,
            file_hash,
        ]);

        
        let signatures_sort_map = new Map();
        let jays_sparsity_check = [];
        
        let signed_weight = 0n;
        for (let i = 0; i < signatures.length; i++) {
            const node_id_short_i = signatures[i].node_id_short;
            for (let j = 0; j < current_validators.length; j++) {
                const pubkey_j = current_validators[j].public_key.pubkey;
                if (node_id_short_i === current_validators[j].node_id_short) {
                    if (!signVerify(message, signatures[i].signature, pubkey_j)) {
                        throw new Error(`Invalid signature! ${i} ${j}`);
                    }
                    block_signatures_dict_serialized.set(BigInt(j), signatures[i].signature);
                    signed_weight += BigInt(current_validators[j].weight.toString());
                    signatures_sort_map.set(j, { pubkey: pubkey_j, sigbuf: signatures[i].signature });
                    jays_sparsity_check.push(j);
                    break;
                }
            }
        }

        jays_sparsity_check = jays_sparsity_check.sort((a: any, b: any) => a - b);


        let resulting_validators_array = [];
        let resulting_signatures_array = [];
        {
            // Logic for serializing signatures in the same order as in the contract's public keys via snake cells (resulting_signatures_array)
            let current_idx = 0;

            // make sure signatures is sorted based on index of each sig's public key in contract's public keys
            signatures_sort_map = new Map([...signatures_sort_map.entries()].sort((a: any, b: any) => a[0] - b[0]));
            let signatures_sorted_arr = Array.from(signatures_sort_map.values());

            for (let s_ix = 0; s_ix < signatures_sorted_arr.length; ++s_ix) {
                let v_idx = current_idx;
                for (v_idx = current_idx; v_idx < current_validators.length; ++v_idx) {
                    if (equal_pubkeys(current_validators[v_idx].public_key.pubkey, signatures_sorted_arr[s_ix].pubkey)) {
                        let skip_idx = v_idx - current_idx;
                        current_idx = v_idx + 1;
                        resulting_signatures_array.push([skip_idx, signatures_sorted_arr[s_ix].sigbuf]);
                    }
                }
            }
            let jays_init_j = jays_sparsity_check[0];
            for (let jays_ix = 0; jays_ix < jays_sparsity_check.length; ++jays_ix) {
                if ((jays_sparsity_check[jays_ix] - jays_init_j) !== jays_ix) {
                    // console.log(">>> jays sparsity check failed");
                    // console.log("resulting_array", resulting_signatures_array);
                    break;
                }
            }
            // console.log("resulting_array", resulting_array, signatures_sorted_arr.length, resulting_array.length);
        }

        if (signed_weight * 3n <= current_validators_total_weight * 2n) {
            if (signed_weight === 0n) {
              throw new Error("Block signers is not a subset of current validators");
            }
            console.log(`Weak signers! ${signed_weight}/${current_validators_total_weight}; seqno=${seqno}; block_signatures_dict_serialized.size=${block_signatures_dict_serialized.size} signatures_quantity=${signatures.length}; validators_quantity=${current_validators.length}`);
            // let kt_weight = 0n; for (let k = 0; k < current_validators.length; k++) { kt_weight += BigInt("0x" + uint8array_to_hex(current_validators.get(BigInt(k))!.slice(5 + 32, 5 + 32 + 8))); }
            // block_signatures_dict_serialized.keys().map((k: bigint) => { console.log(`pubkey=${uint8array_to_hex(current_validators.get(k)!.slice(5, 5 + 32))}; weight=${BigInt("0x" + uint8array_to_hex(current_validators.get(k)!.slice(5 + 32, 5 + 32 + 8)))}`); });
            // console.log(`ALL_WEIGHT=${kt_weight}`);
            // console.log("Trying to get signatures with stronger signers...");
            // There's a chance of lite server returning signatures from underpowered signers. In this case
            // we try to obtain a signature set with stronger signers by querying the lite server once again.
            return await fetch_key_block_with_next_validators_by_seqno(ls_pair, seqno);
        }
        {
            // Logic for serializing public keys (resulting_validators_array)
            if (current_validators.length === 30) {
                // console.log("30 validators!");
                for (let i = 0; i < current_validators.length; i++) {
                    resulting_validators_array.push([BigInt("0x" + uint8array_to_hex(current_validators[i].public_key.pubkey)), BigInt(current_validators[i].weight.toString())]);
                }

                // console.log("validators array", resulting_validators_array);

                const _30_validators = generate_validators_cell(resulting_validators_array);

                await fs.writeFile(`tests/cache/validator_storage.boc`, _30_validators.toBoc());

                // console.log(`... and ${signatures.length} signatures!`);
                const _some_signatures = generate_signatures_cell(resulting_signatures_array);

                await fs.writeFile(`tests/cache/signatures_data.boc`, _some_signatures.toBoc());
                // console.log(`<<< validators sparsity: ${resulting_signatures_array.map((v: any) => v[0])}`);
            }
        }
    }

    console.log(`Successfully got valid key block (seqno=${seqno}) containing new validators`);

    return {
        block: block_cell,
        file_hash: BigInt("0x" + uint8array_to_hex(file_hash)),
        block_signatures: block_signatures_dict_serialized
    }
}

export async function fetch_contract_setup_info(ls_pair: LSPair, seqno: number) {
    const { signatures, root_hash, file_hash } = (await get_block_signatures(ls_pair, seqno))!;
    const block_raw = (await get_block_raw(ls_pair, seqno, Buffer.from(root_hash, "base64"), Buffer.from(file_hash, "base64"), -1, "-9223372036854775808"))!;

    const block_cell = Cell.fromBoc(block_raw)[0];

    const block_parsed = (await parse_block_raw(block_raw))!;

    {
        // Sanity checks

        if (!block_parsed.info.key_block) {
            throw new Error(`Not a key block!`);
        }
        if (!block_parsed.extra.custom.config.config.map.get("24")) {
            throw new Error(`Does not contain new validators!`);
        }
        const root_hash_prime = block_cell.hash().toString("base64");
        if (root_hash_prime !== root_hash) {
            throw new Error(`Root hashes are not equal! ${root_hash_prime} != ${root_hash}`);
        }
    }

    const current_validators_dict = Array.from(block_parsed.extra.custom.config.config.map.get("22").cur_validators.list.map.entries()) as any;
    const next_validators_dict = Array.from(block_parsed.extra.custom.config.config.map.get("24").next_validators.list.map.entries()) as any;

    const current_validators_total_weight = BigInt(block_parsed.extra.custom.config.config.map.get("22").cur_validators.total_weight.toString(10));
    const next_validators_total_weight = BigInt(block_parsed.extra.custom.config.config.map.get("24").next_validators.total_weight.toString(10));

    const current_validators_time_until = BigInt(block_parsed.extra.custom.config.config.map.get("22").cur_validators.utime_until.toString(10));
    const next_validators_time_until = BigInt(block_parsed.extra.custom.config.config.map.get("24").next_validators.utime_until.toString(10));

    let current_validators_dict_serialized = Dictionary.empty(
        Dictionary.Keys.BigUint(16),
        Dictionary.Values.Buffer(1 + 4 + 32 + 8),  // 1 byte prefix, 4 bytes prefix, 32 bytes - validator's pubkey, 8 bytes - validator's weight
    );

    let next_validators_dict_serialized = Dictionary.empty(
        Dictionary.Keys.BigUint(16),
        Dictionary.Values.Buffer(1 + 4 + 32 + 8),  // 1 byte prefix, 4 bytes prefix, 32 bytes - validator's pubkey, 8 bytes - validator's weight
    );

    for (let i = 0; i < current_validators_dict.length; i++) {
        const padded_weight = hex_to_uint8array(BigInt(current_validators_dict[i][1].weight.toString()).toString(16).padStart(16, "0"))
        let validator_descr = Buffer.alloc(45);
        validator_descr.set(current_validators_dict[i][1].public_key.pubkey, 5);
        validator_descr.set(padded_weight, 37);
        current_validators_dict_serialized.set(BigInt("0x" + current_validators_dict[i][0]), validator_descr);
    }

    for (let i = 0; i < next_validators_dict.length; i++) {
        const padded_weight = hex_to_uint8array(BigInt(next_validators_dict[i][1].weight.toString()).toString(16).padStart(16, "0"))
        let validator_descr = Buffer.alloc(45);
        validator_descr.set(next_validators_dict[i][1].public_key.pubkey, 5);
        validator_descr.set(padded_weight, 37);
        next_validators_dict_serialized.set(BigInt("0x" + next_validators_dict[i][0]), validator_descr);
    }

    let block_signatures_dict_serialized = Dictionary.empty(
        Dictionary.Keys.BigUint(16),
        Dictionary.Values.Buffer(64),
    );

    {
        // Signatures check

        const message = Buffer.concat([
            Buffer.from([0x70, 0x6e, 0x0b, 0xc5]),
            Buffer.from(root_hash, "base64"),
            Buffer.from(file_hash, "base64"),
        ]);

        let signed_weight = 0n;

        for (let i = 0; i < signatures.length; i++) {
            const node_id_short_i = signatures[i].node_id_short;
            for (let j = 0; j < current_validators_dict.length; j++) {
                const pubkey_j = current_validators_dict[j][1].public_key.pubkey;
                const node_id_short_j = await get_node_id_short(pubkey_j);
                if (node_id_short_i === node_id_short_j) {
                    if (!signVerify(message, signatures[i].signature, pubkey_j)) {
                        throw new Error(`Invalid signature! ${i} ${j}`);
                    }
                    block_signatures_dict_serialized.set(BigInt("0x" + current_validators_dict[j][0]), signatures[i].signature);
                    signed_weight += BigInt(current_validators_dict[j][1].weight.toString());
                    // console.log(`j=${j}; pubkey=${uint8array_to_hex(pubkey_j)}; node_id_short=${Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.concat([Buffer.from([0xc6, 0xb4, 0x13, 0x48]), pubkey_j]))).toString("hex").toUpperCase()}; val_weight=${current_validators_dict[j][1].weight}`);
                    break;
                }
            }
        }

        if (signed_weight * 3n <= current_validators_total_weight * 2n) {
            if (signed_weight === 0n) {
              throw new Error("Block signers is not a subset of current validators");
            }
            console.log(`Weak signers! ${signed_weight}/${current_validators_total_weight}; seqno=${seqno}`);
            // console.log(`${block_signatures_dict_serialized.size} signatures; ${signatures.length} signatures; ${current_validators_dict.length} validators`);
            // let kt_weight: bigint = 0n; for (let k = 0; k < current_validators_dict.length; k++) { kt_weight += BigInt(current_validators_dict[k][1].weight.toString()); }
            // console.log(`ALL_WEIGHT=${kt_weight}`);
            // for (let k = 0; k < current_validators_dict.length; k++) { console.log(`[${k}] val_node_id_short=${await get_node_id_short(current_validators_dict[k][1].public_key.pubkey)}`); }
            console.log("Trying to get signatures with stronger signers...");
            // There's a chance of lite server returning signatures from underpowered signers. In this case
            // we try to obtain a signature set with stronger signers by querying the lite server once again.
            return await fetch_contract_setup_info(ls_pair, seqno);
        }
    }

    console.log(`Setup backed with ${signatures.length} validators!`);

    return {
        block: block_cell,
        file_hash: BigInt("0x" + uint8array_to_hex(Buffer.from(file_hash, "base64"))),
        block_signatures: block_signatures_dict_serialized,

        current_validators_time_until,
        current_validators_total_weight: current_validators_total_weight,
        current_validators: current_validators_dict_serialized,

        next_validators_time_until,
        next_validators_total_weight: next_validators_total_weight,
        next_validators: next_validators_dict_serialized,
    }
}

export async function fetch_block(ls_pair: LSPair, seqno: number, current_validators_total_weight: bigint, current_validators_dict: any, next_validators_total_weight: bigint, next_validators_dict: any, block_raw: Buffer | null = null, root_hash: Buffer | null = null, file_hash: Buffer | null = null, attempts = 0) {
    const { signatures } = (await get_block_signatures(ls_pair, seqno, true))!;
    if (!block_raw) {
        const hashes = (await get_block_root_and_file_hashes(ls_pair, seqno, -1, "-9223372036854775808"))!;
        root_hash = hashes.root_hash;
        file_hash = hashes.file_hash;
        block_raw = (await get_block_raw(ls_pair, seqno, root_hash, file_hash, -1, "-9223372036854775808", true))!;
    }
    const block_cell = Cell.fromBoc(block_raw!)[0];

    let block_signatures_dict_serialized = Dictionary.empty(
        Dictionary.Keys.BigUint(16),
        Dictionary.Values.Buffer(64),
    );

    let do_validators_switch_for_check_block = false;
    
    {
        let coincided_node_id_shorts = 0;
        for (let i = 0; i < signatures.length; i++) {
            const node_id_short_i = signatures[i].node_id_short;
            for (let j = 0; j < current_validators_dict.size; j++) {
                const current_validators_dict_j = current_validators_dict.get(BigInt(j));
                const pubkey_j = current_validators_dict_j.slice(5, 5 + 32);
                const node_id_short_j = await get_node_id_short(pubkey_j);
                if (node_id_short_i === node_id_short_j) {
                    coincided_node_id_shorts++;
                    break;
                }
            }
        }

        if (coincided_node_id_shorts < signatures.length) {
            console.log("Making a switch!");
            do_validators_switch_for_check_block = true;
            current_validators_dict = next_validators_dict;
            current_validators_total_weight = next_validators_total_weight;
        }
    }

    {
        // Signatures check

        const message = Buffer.concat([
            Buffer.from([0x70, 0x6e, 0x0b, 0xc5]),
            root_hash!,
            file_hash!,
        ]);

        let signed_weight = 0n;

        for (let i = 0; i < signatures.length; i++) {
            const node_id_short_i = signatures[i].node_id_short;
            for (let j = 0; j < current_validators_dict.size; j++) {
                const current_validators_dict_j = current_validators_dict.get(BigInt(j));
                const pubkey_j = current_validators_dict_j.slice(5, 5 + 32);
                const weight_j = current_validators_dict_j.slice(5 + 32, 5 + 32 + 8);
                const node_id_short_j = await get_node_id_short(pubkey_j);
                if (node_id_short_i === node_id_short_j) {
                    if (!signVerify(message, signatures[i].signature, pubkey_j)) {
                        throw new Error(`Invalid signature! ${i} ${j}`);
                    }
                    block_signatures_dict_serialized.set(BigInt(j), signatures[i].signature);
                    signed_weight += BigInt("0x" + uint8array_to_hex(weight_j));
                    break;
                }
            }
        }

        if (signed_weight * 3n <= current_validators_total_weight * 2n) {
            if (signed_weight === 0n) {
                throw new Error("Block signers is not a subset of current validators");
            }
            if (block_signatures_dict_serialized.size !== signatures.length) {
                throw new Error("Block signers is not a subset of current validators (block_signatures_dict_serialized.size !== signatures.length)");
            }
            console.log(`[${attempts}] Weak signers! ${signed_weight}/${current_validators_total_weight}; seqno=${seqno}; block_signatures_dict_serialized.size=${block_signatures_dict_serialized.size} signatures_quantity=${signatures.length}; validators_quantity=${current_validators_dict.size}`);
            console.log("Trying to get signatures with stronger signers...");
            // There's a chance of lite server returning signatures from underpowered signers. In this case
            // we try to obtain a signature set with stronger signers by querying the lite server once again.
            if (attempts > 10) {
                return { weak_signatures_from_archival_node: true, seqno: seqno };
            }
            return await fetch_block(ls_pair, seqno, current_validators_total_weight, current_validators_dict, next_validators_total_weight, next_validators_dict, block_raw, root_hash, file_hash, attempts + 1);
        }
    }

    return {
        seqno: seqno,
        block: block_cell,
        file_hash: BigInt("0x" + uint8array_to_hex(file_hash!)),
        block_signatures: block_signatures_dict_serialized,
        weak_signatures_from_archival_node: false,
        do_validators_switch_for_check_block
    };
}

export async function get_contract_setup_info(ls_pair: LSPair, seqno: number) {
    const result = await fetch_contract_setup_info(ls_pair, seqno);

    return beginCell()
            .storeUint(result.current_validators_time_until, 32)
            .storeUint(result.current_validators_total_weight, 64)
            .storeDict(result.current_validators, Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(1 + 4 + 32 + 8))
            .storeUint(result.next_validators_time_until, 32)
            .storeUint(result.next_validators_total_weight, 64)
            .storeDict(result.next_validators, Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(1 + 4 + 32 + 8))
            .storeUint(seqno, 32)
           .endCell();
}