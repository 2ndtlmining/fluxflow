// Convert fluxd `getblock <height> 2` JSON into the transaction shape that
// FluxFlow's BlockSyncService.processTransaction() consumes today
// (Blockbook-style: vin/vout with `addresses` and `value` in satoshis).
//
// fluxd facts (RunOnFlux/fluxd src/rpc/rawtransaction.cpp TxToJSON):
//  - vout[].value is in FLUX, vout[].valueSat / valueZat in satoshis
//  - vout[].scriptPubKey.addresses holds the address(es)
//  - vin[].address + vin[].valueSat exist only with insightexplorer
//    (spent index); coinbase inputs carry `coinbase` instead
//  - fluxnode start/confirm txs have `type` and no vin/vout

export function classifyTxKind(tx) {
  if (tx.type && !tx.vin) return 'fluxnode'; // start / confirm
  if (tx.vin?.length && tx.vin[0].coinbase !== undefined) return 'coinbase';
  const shielded = (tx.vShieldedSpend?.length || 0) + (tx.vShieldedOutput?.length || 0) + (tx.vJoinSplit?.length || 0);
  if (shielded > 0) return 'shielded';
  return 'transfer';
}

export function normalizeTx(tx) {
  const kind = classifyTxKind(tx);
  const vin = (tx.vin || [])
    .filter((i) => i.coinbase === undefined)
    .map((i) => ({
      addresses: i.address ? [i.address] : [],
      value: i.valueSat !== undefined ? String(i.valueSat) : undefined,
      prevTxid: i.txid,
      prevVout: i.vout,
    }));
  const vout = (tx.vout || []).map((o, idx) => ({
    addresses: o.scriptPubKey?.addresses || [],
    value: String(o.valueSat ?? o.valueZat ?? Math.round(Number(o.value) * 1e8)),
    n: o.n ?? idx,
    scriptType: o.scriptPubKey?.type,
  }));
  return { txid: tx.txid, kind, vin, vout };
}

export function normalizeBlock(block) {
  return {
    height: block.height,
    hash: block.hash,
    previousblockhash: block.previousblockhash,
    time: block.time,
    size: block.size,
    blockType: block.type, // 'PON' | 'POW'
    txCount: block.tx.length,
    txs: block.tx.map(normalizeTx),
  };
}
