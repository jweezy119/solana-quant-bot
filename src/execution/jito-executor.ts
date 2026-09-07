import { Connection, Keypair, VersionedTransaction, SystemProgram, TransactionMessage, PublicKey, AddressLookupTableAccount } from '@solana/web3.js';
import bs58 from 'bs58';
import { JITO_BLOCK_ENGINE, JITO_TIP_LAMPORTS } from '../core/config';

// Jito tip accounts
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTQVPeGvrv9AWkGvTuUvdSQ312fVvB9nMnV',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iMgaSbg',
  'DfXygSm4jcyNCybVYYK6DwvWqjKee8pbKD5X5QY5GhzE',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwLcvw',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBn13EQ7Nn',
  'DttWaMuVvTiduZdP3514vAZ4FmKj65JqMvS2aN3tQ5j8',
];

/**
 * Sends a transaction as a Jito MEV Bundle
 * Creates a separate tip transaction and bundles it with the main transaction.
 */
export async function sendJitoBundle(
  connection: Connection,
  kp: Keypair,
  mainTxBase64: string,
): Promise<string> {
  const mainTx = VersionedTransaction.deserialize(Buffer.from(mainTxBase64, 'base64'));
  mainTx.sign([kp]);

  // Create Tip Transaction
  const tipAccountStr = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  const tipAccount = new PublicKey(tipAccountStr);
  
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  
  const tipIx = SystemProgram.transfer({
    fromPubkey: kp.publicKey,
    toPubkey: tipAccount,
    lamports: JITO_TIP_LAMPORTS,
  });

  const tipMessage = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: blockhash,
    instructions: [tipIx],
  }).compileToV0Message();

  const tipTx = new VersionedTransaction(tipMessage);
  tipTx.sign([kp]);

  // Serialize and encode
  const b64Main = Buffer.from(mainTx.serialize()).toString('base64');
  const b64Tip = Buffer.from(tipTx.serialize()).toString('base64');

  // Send Bundle via REST API
  console.log(`📦 Sending MEV bundle to Jito (tip: ${JITO_TIP_LAMPORTS} lamports)`);
  
  const url = `${JITO_BLOCK_ENGINE}/api/v1/bundles`;
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendBundle',
    params: [[b64Main, b64Tip]]
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000), // 10s timeout
  });

  if (!response.ok) {
    throw new Error(`Jito Bundle HTTP Error: ${response.status}`);
  }

  const json: any = await response.json();
  if (json.error) {
    throw new Error(`Jito Bundle Error: ${(json as any).error?.message || 'Unknown'}`);
  }

  // Jito returns the bundle UUID. The actual transaction signature is the first signature of mainTx
  const signature = bs58.encode(mainTx.signatures[0]);
  
  // Wait for confirmation
  const lbh = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    { signature, blockhash: lbh.blockhash, lastValidBlockHeight: lbh.lastValidBlockHeight },
    'confirmed',
  );

  return signature;
}
