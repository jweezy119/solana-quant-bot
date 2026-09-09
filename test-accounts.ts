import { getAllAccounts } from './src/coinbase/client';

async function run() {
    const accounts = await getAllAccounts();
    console.log(`Found ${accounts.length} accounts.`);
    accounts.forEach(acc => {
        const available = parseFloat(acc.available_balance?.value || '0');
        const hold = parseFloat(acc.hold?.value || '0');
        if (available > 0 || hold > 0) {
            console.log(`- ${acc.currency}: Available=${available}, Hold=${hold}`);
        }
    });
}
run();
