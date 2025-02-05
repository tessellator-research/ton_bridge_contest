import { toNano } from "@ton/core";
import { get_contract_setup_info, LSPair } from "../scripts/utils";
import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, Dictionary } from "@ton/core";
import { exec } from "child_process";
import { promisify } from "util";

const exec_cmd = promisify(exec);

async function exec_shell_command(cmd: string) {
    try {
        const { stdout, stderr } = await exec_cmd(cmd);
        if (stderr) {
            throw new Error(`Error: ${stderr}`);
        }
        return stdout;
    } catch (error: any) {
        throw new Error(error.message);
    }
}

export async function run_build_contract(contract_name: string) {
    try {
        // This is for UNIX systems. Replace commands according to your system
        await exec_shell_command(`func -Wout.boc contracts/${contract_name}.fc > out.fif`);
        await exec_shell_command("fift -s out.fif");
        const result = await exec_shell_command("cat out.boc | base64 -w0");
        return result;
    } catch (error: any) {
        console.error(`Execution failed: ${error.message}`);
    }
}

export class TransactionCheckerContract implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static async createFromConfig(lite_client_address: Address, workchain = 0) {
        const data = beginCell()
                        .storeAddress(lite_client_address)
                        .storeDict(Dictionary.empty(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell()), Dictionary.Keys.BigUint(64), Dictionary.Values.Cell())
                    .endCell();
        const output = await run_build_contract("transaction-checker");
        const code = Cell.fromBase64(output!);
        const init = { code, data };
        return new TransactionCheckerContract(contractAddress(workchain, init), init);
    }

    async sendDeployTransactionChecker(provider: ContractProvider, via: Sender, value: bigint, lite_client_address: Address) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                    .storeAddress(lite_client_address)
                    .storeDict(Dictionary.empty(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell()), Dictionary.Keys.BigUint(64), Dictionary.Values.Cell())
                  .endCell(),
        });
    }

    async sendCheckTransactionInMcBlock(provider: ContractProvider, via: Sender, arbitrary_block: { block: Cell, signatures: any, file_hash: bigint, account_dict_key: bigint, transaction_dict_key: bigint, transaction_cell: Cell, do_validators_switch_for_check_block: boolean }) {
        await provider.internal(via, {
            value: toNano("0.4"),
            sendMode: 0,
            body: beginCell()
                    .storeUint(0x91d555f7, 32)
                    .storeRef(arbitrary_block.block)
                    .storeDict(arbitrary_block.signatures, Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(64))
                    .storeUint(arbitrary_block.file_hash, 256)
                    .storeUint(arbitrary_block.account_dict_key, 256)
                    .storeUint(arbitrary_block.transaction_dict_key, 64)
                    .storeRef(arbitrary_block.transaction_cell)
                    .storeUint(Number(arbitrary_block.do_validators_switch_for_check_block), 1)
                  .endCell(),
        });
    }
}

export class LiteClientContract implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static async createFromConfig(ls_pair: LSPair, init_block_seqno: number, workchain = 0) {
        const data = await get_contract_setup_info(ls_pair, init_block_seqno);
        const output = await run_build_contract("lite-client");
        const code = Cell.fromBase64(output!);
        const init = { code, data };
        return new LiteClientContract(contractAddress(workchain, init), init);
    }

    async sendDeployLiteClient(provider: ContractProvider, via: Sender, ls_pair: LSPair, init_block_seqno: number, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: await get_contract_setup_info(ls_pair, init_block_seqno),
        });
    }

    async sendNewKeyBlock(provider: ContractProvider, via: Sender, query_id: bigint, proper_key_block: { block: Cell, signatures: any, file_hash: bigint }) {
        await provider.internal(via, {
            value: toNano("0.2"),
            sendMode: 0,
            body: beginCell()
                    .storeUint(0x11a78ffe, 32)
                    .storeUint(query_id, 64)
                    .storeRef(proper_key_block.block)
                    .storeDict(proper_key_block.signatures, Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(64))
                    .storeUint(proper_key_block.file_hash, 256)
                    .storeUint(0, 1)
                  .endCell(),
        });
    }

    async sendCheckMcBlock(provider: ContractProvider, via: Sender, query_id: bigint, arbitrary_block: { block: Cell, signatures: any, file_hash: bigint, do_validators_switch_for_check_block: boolean }) {
        await provider.internal(via, {
            value: toNano("0.2"),
            sendMode: 0,
            body: beginCell()
                    .storeUint(0x8eaa9d76, 32)
                    .storeUint(query_id, 64)
                    .storeRef(arbitrary_block.block)
                    .storeDict(arbitrary_block.signatures, Dictionary.Keys.BigUint(16), Dictionary.Values.Buffer(64))
                    .storeUint(arbitrary_block.file_hash, 256)
                    .storeUint(Number(arbitrary_block.do_validators_switch_for_check_block), 1)
                  .endCell(),
        });
    }
}
