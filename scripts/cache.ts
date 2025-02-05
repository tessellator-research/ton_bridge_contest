import { promises as fs } from "fs";

export async function save_signatures(signatures_obj: object, block_seqno: number) {
  await fs.writeFile(`tests/cache/mc_block_${block_seqno}_signatures.json`, JSON.stringify(signatures_obj, null, 2), "utf8");
}

export async function read_signatures(block_seqno: number): Promise<any | null> {
    try {
        const data = await fs.readFile(`tests/cache/mc_block_${block_seqno}_signatures.json`, "utf8");
        return JSON.parse(data);
    } catch (error: any) {
      return null;
    }
}

export async function save_raw_mc_block(block_boc: Buffer, block_seqno: number, workchain: number, shard: string) {
  await fs.writeFile(`tests/cache/raw_mc_block_${block_seqno}_${workchain}_${shard}.data`, block_boc);
}

export async function read_raw_mc_block(block_seqno: number, workchain: number, shard: string): Promise<Buffer | null> {
    try {
        const data = await fs.readFile(`tests/cache/raw_mc_block_${block_seqno}_${workchain}_${shard}.data`);
      return data;
    } catch (error: any) {
      return null;
    }
}
