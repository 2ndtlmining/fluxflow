// Check that node-sourced blocks contain everything FluxFlow needs, and run
// them through the app's own classification code unchanged.

import path from 'node:path';
import { FLUX_CONFIG } from '../../../src/lib/config.js';
import ClassificationService from '../../../src/lib/services/classificationService.js';
import BlockSyncService from '../../../src/lib/services/Blocksyncservice.js';
import { normalizeBlock } from './normalize.mjs';

const MAX_REASONABLE_FEE_SAT = 1e8; // 1 FLUX

export function buildClassifier(nodeListRaw, repoRoot) {
  FLUX_CONFIG.EXCHANGES_CONFIG_PATH = path.join(repoRoot, 'src/lib/data/exchanges.json');
  const quiet = console.log;
  console.log = () => {};
  const classifier = new ClassificationService();
  console.log = quiet;
  // Same aggregation as ClassificationService.refreshNodeOperators(), fed
  // from the node list we already downloaded for discovery.
  for (const node of nodeListRaw) {
    const addr = node.payment_address;
    if (!addr) continue;
    if (!classifier.nodeOperators.has(addr)) {
      classifier.nodeOperators.set(addr, { address: addr, nodes: [], tiers: { CUMULUS: 0, NIMBUS: 0, STRATUS: 0 }, totalCollateral: 0 });
    }
    const op = classifier.nodeOperators.get(addr);
    op.nodes.push(node);
    const tier = node.tier || 'CUMULUS';
    op.tiers[tier] = (op.tiers[tier] || 0) + 1;
  }
  classifier.lastNodeRefresh = Date.now();
  return classifier;
}

function makeSyncService() {
  const quiet = console.log;
  console.log = () => {};
  const svc = new BlockSyncService({ saveTransaction() {}, saveBlock() {} });
  console.log = quiet;
  return svc;
}

export async function validateBlocks(rawBlocks, classifier) {
  const sync = makeSyncService();
  const report = {
    blocks: 0,
    blockTypes: {},
    txKinds: {},
    transfers: 0,
    transfersWithFullInputs: 0,
    inputsTotal: 0,
    inputsMissingAddressOrValue: 0,
    conservationChecked: 0,
    conservationFailures: [],
    feeSatTotal: 0,
    outputsTotal: 0,
    outputsWithAddress: 0,
    coinbaseOutputs: 0,
    coinbaseOutputsToKnownNodeOperators: 0,
    coinbaseValueSat: 0,
    coinbaseValueToNodeOperatorsSat: 0,
    coinbaseRecipients: new Set(),
    relevantTxs: 0,
    flowEvents: 0,
    flowByType: {},
    flowAmountByType: {},
    fromTypes: {},
    toTypes: {},
    exchangeHits: {},
    sampleEvents: [],
    largestTransfers: [],
  };

  const sorted = [...rawBlocks].sort((a, b) => a.height - b.height);
  for (const raw of sorted) {
    const block = normalizeBlock(raw);
    report.blocks++;
    report.blockTypes[block.blockType || 'unknown'] = (report.blockTypes[block.blockType || 'unknown'] || 0) + 1;

    for (const tx of block.txs) {
      report.txKinds[tx.kind] = (report.txKinds[tx.kind] || 0) + 1;

      if (tx.kind === 'coinbase') {
        for (const o of tx.vout) {
          report.coinbaseOutputs++;
          report.coinbaseValueSat += Number(o.value);
          const a = o.addresses[0];
          if (a) report.coinbaseRecipients.add(a);
          if (a && classifier.nodeOperators.has(a)) {
            report.coinbaseOutputsToKnownNodeOperators++;
            report.coinbaseValueToNodeOperatorsSat += Number(o.value);
          }
        }
        continue;
      }
      if (tx.kind === 'fluxnode') continue;

      report.transfers++;
      let complete = true;
      let inSat = 0;
      for (const i of tx.vin) {
        report.inputsTotal++;
        if (!i.addresses.length || i.value === undefined) {
          report.inputsMissingAddressOrValue++;
          complete = false;
        } else {
          inSat += Number(i.value);
        }
      }
      let outSat = 0;
      for (const o of tx.vout) {
        report.outputsTotal++;
        if (o.addresses.length) report.outputsWithAddress++;
        outSat += Number(o.value);
      }
      if (complete) report.transfersWithFullInputs++;

      if (complete && tx.kind === 'transfer' && tx.vin.length > 0) {
        report.conservationChecked++;
        const fee = inSat - outSat;
        if (fee < 0 || fee > MAX_REASONABLE_FEE_SAT) {
          report.conservationFailures.push({ txid: tx.txid, inSat, outSat });
        } else {
          report.feeSatTotal += fee;
        }
      }
      report.largestTransfers.push({ txid: tx.txid, height: block.height, flux: outSat / 1e8 });

      // --- Run FluxFlow's own code on the normalised tx ---------------------
      if (sync.isRelevantTransaction(tx, classifier)) {
        report.relevantTxs++;
        const events = await sync.processTransaction(tx, block.height, block.time, classifier);
        for (const e of events) {
          report.flowEvents++;
          report.flowByType[e.flowType] = (report.flowByType[e.flowType] || 0) + 1;
          report.flowAmountByType[e.flowType] = (report.flowAmountByType[e.flowType] || 0) + e.amount;
          report.fromTypes[e.fromType] = (report.fromTypes[e.fromType] || 0) + 1;
          report.toTypes[e.toType] = (report.toTypes[e.toType] || 0) + 1;
          const ex = e.flowType === 'selling' ? e.toDetails?.name : e.flowType === 'buying' ? e.fromDetails?.name : null;
          if (ex) report.exchangeHits[ex] = (report.exchangeHits[ex] || 0) + 1;
          if (e.flowType !== 'p2p' && report.sampleEvents.length < 12) {
            report.sampleEvents.push({
              height: e.blockHeight, txid: e.txid, flowType: e.flowType,
              from: e.fromAddress, fromType: e.fromType,
              to: e.toAddress, toType: e.toType,
              exchange: ex, amount: e.amount,
            });
          }
        }
      }
    }
  }

  report.largestTransfers = report.largestTransfers.sort((a, b) => b.flux - a.flux).slice(0, 5);
  report.coinbaseRecipients = report.coinbaseRecipients.size;
  return report;
}
