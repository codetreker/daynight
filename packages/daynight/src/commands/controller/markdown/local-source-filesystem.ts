/** Interpret the native filesystem record for the supported 64-bit POSIX ABIs. */
export function isSupportedLocalImageFilesystem(bytes: Buffer, platform: NodeJS.Platform): boolean {
  if (platform === "darwin") {
    // Darwin statfs64 exposes f_flags at 64, f_fstypename[16] at 72 and
    // f_flags_ext at 2136. MNT_EXT_FSKIT identifies a userspace mount:
    // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/mount.h#L107-L129
    // f_type is a kernel registration number, not a stable filesystem magic:
    // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/vfs/vfs_syscalls.c#L3768-L3789
    if (bytes.length < 2140 || (bytes.readUInt32LE(64) & 0x1000) === 0 || (bytes.readUInt32LE(2136) & 0x2) !== 0) return false;
    const field = bytes.subarray(72, 88), end = field.indexOf(0);
    if (end < 0) return false;
    const name = field.subarray(0, end);
    return name.equals(Buffer.from("apfs")) || name.equals(Buffer.from("hfs"));
  }
  return platform === "linux" && bytes.length >= 4 && [0xef53, 0x58465342, 0x9123683e, 0x01021994].includes(bytes.readUInt32LE(0));
}
