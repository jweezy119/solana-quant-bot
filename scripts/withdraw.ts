import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import 'dotenv/config';

async function withdraw(destinationAddress: string) {
  try {
    const secretKeyString = process.env.PRIVATE_KEY;
    if (!secretKeyString) throw new Error('PRIVATE_KEY not found in .env');
    const secretKey = bs58.decode(secretKeyString.replace(/\\s+/g, ''));
    const keypair = Keypair.fromSecretKey(secretKey);

    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
    
    const balance = await connection.getBalance(keypair.publicKey);
    console.log(`Current Balance: ${balance / 1e9} SOL`);

    // Leave a tiny bit for the transaction fee (~0.000005 SOL)
    const feeBuffer = 5000; 
    const transferAmount = balance - feeBuffer;
    
    if (transferAmount <= 0) {
      console.log('Insufficient balance to transfer.');
      return;
    }

    const toPubkey = new PublicKey(destinationAddress);

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: toPubkey,
        lamports: transferAmount,
      })
    );

    console.log(`Transferring ${(transferAmount / 1e9).toFixed(5)} SOL to ${destinationAddress}...`);
    const signature = await sendAndConfirmTransaction(connection, tx, [keypair]);
    console.log('Transfer complete! Signature:', signature);
  } catch (err: any) {
    console.error('Failed to withdraw:', err.message);
  }
}

const dest = process.argv[2];
if (!dest) {
  console.log('Usage: npx ts-node scripts/withdraw.ts <destination_address>');
} else {
  withdraw(dest);
}
