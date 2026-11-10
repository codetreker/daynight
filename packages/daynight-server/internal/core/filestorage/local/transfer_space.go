package local

import (
	"context"
	"errors"
	"fmt"
	"math"

	"golang.org/x/sys/unix"
)

func (s *Storage) AvailableTransferBytes(ctx context.Context) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	file, err := s.root.Open(".")
	if err != nil {
		return 0, err
	}
	var stat unix.Statfs_t
	err = errors.Join(unix.Fstatfs(int(file.Fd()), &stat), file.Close(), ctx.Err())
	if err != nil {
		return 0, err
	}
	return transferAvailableBytes(uint64(stat.Bavail), transferBlockSize(&stat))
}

func transferAvailableBytes(blocks, blockSize uint64) (int64, error) {
	if blockSize == 0 {
		return 0, fmt.Errorf("invalid filesystem block size")
	}
	if blocks > math.MaxInt64/blockSize {
		return math.MaxInt64, nil
	}
	return int64(blocks * blockSize), nil
}

// ResourceSpace reports the actual volume capacity for conservative admission.
func (s *Storage) ResourceSpace(ctx context.Context) (available, total int64, result error) {
	if err := ctx.Err(); err != nil {
		return 0, 0, err
	}
	file, err := s.root.Open(".")
	if err != nil {
		return 0, 0, err
	}
	var stat unix.Statfs_t
	if err = errors.Join(unix.Fstatfs(int(file.Fd()), &stat), file.Close(), ctx.Err()); err != nil {
		return 0, 0, err
	}
	block := transferBlockSize(&stat)
	available, err = transferAvailableBytes(uint64(stat.Bavail), block)
	if err != nil {
		return 0, 0, err
	}
	total, err = transferAvailableBytes(uint64(stat.Blocks), block)
	return available, total, err
}
