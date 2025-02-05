import { Slice } from "@ton/core";

function deserialize_unary(ser: Slice): number {
    let n = 0;
    let r = ser.loadBit();
    while (r) {
        n += 1;
        r = ser.loadBit();
    }
    return n;
}

function deserialize_hml(ser: Slice, m: bigint) {
    let k = ser.loadUint(1);
    let s = 0n;
    let n = -1;
    if (k) {
        k = (k << 1) | ser.loadUint(1);
    }
    if (k === 0) {
        n = deserialize_unary(ser);
        s = ser.loadUintBig(n);
    } else if (k === 2) {
        let l = m.toString(2).length;
        n = ser.loadUint(l);
        s = ser.loadUintBig(n);
    } else {  // same
        let v = ser.loadBit();
        let l = m.toString(2).length;
        n = ser.loadUint(l);
        if (v) {
            s = (1n << BigInt(n)) - 1n;
        }
    }
    return { l: BigInt(n), suffix: s };
}

function deserialize_hashmap_aug_node(cs: Slice, m: bigint, ret_dict: any, prefix: bigint, ) {
    if (m == 0n) {  // ahmn_leaf
        ret_dict.set(prefix, cs);
    } else {  // ahmn_fork
        {
            const slice = cs.loadRef().beginParse();
            let { l, suffix } = deserialize_hml(slice, m - 1n);
            deserialize_hashmap_aug_node(slice, m - 1n - l, ret_dict, (((prefix << 1n) << l) | suffix));
        }
        {
            const slice = cs.loadRef().beginParse();
            let { l, suffix } = deserialize_hml(slice, m - 1n);
            deserialize_hashmap_aug_node(slice, m - 1n - l, ret_dict, ((((prefix << 1n) | 1n) << l) | suffix));
        }
    }
}

export function parse_hashmap_aug(dict_cell: Slice, key_len: number) {
    let result = new Map<bigint, Slice>();
    let { l, suffix }  = deserialize_hml(dict_cell, BigInt(key_len));
    deserialize_hashmap_aug_node(dict_cell, BigInt(key_len) - l, result, suffix);
    return result;
}
