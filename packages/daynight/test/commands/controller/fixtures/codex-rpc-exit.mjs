import { createInterface } from 'node:readline';

for await (const line of createInterface({ input: process.stdin })) {
 const request = JSON.parse(line);
 const messages = Array.from({ length: 1000 }, (_, index) => ({ method: 'notice', params: { index, text: 'final native output'.repeat(4) } }));
 messages.push({ id: request.id, result: { confirmed: true } });
 await new Promise((resolve, reject) => process.stdout.write(messages.map(value => JSON.stringify(value) + '\n').join(''), error => error ? reject(error) : resolve()));
 break;
}
process.stdin.destroy();
