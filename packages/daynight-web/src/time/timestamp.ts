// Sub-millisecond facts must remain distinct at a local calendar boundary.
export const timestampNanoseconds = (value: string): bigint => BigInt(Date.parse(`${value.slice(0, 19)}Z`)) * 1_000_000n +
  BigInt((value[19] === "." ? value.slice(20, -1) : "").padEnd(9, "0"));
