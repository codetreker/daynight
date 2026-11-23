package sessionarchive

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"

	"github.com/google/uuid"
)

// BlockSize is the v2 archive upload block size; only the last block may be shorter.
const BlockSize int64 = 512 * 1024

// InitialPrefixProof identifies the empty confirmed prefix of a v2 upload.
func InitialPrefixProof() [sha256.Size]byte {
	return sha256.Sum256([]byte("daynight-archive-prefix-v2"))
}

// AdvancePrefixProof incorporates one block's offset, length and SHA-256 digest.
func AdvancePrefixProof(previous [sha256.Size]byte, offset uint64, length uint32, digest [sha256.Size]byte) [sha256.Size]byte {
	var input [sha256.Size + 8 + 4 + sha256.Size]byte
	copy(input[:], previous[:])
	binary.BigEndian.PutUint64(input[sha256.Size:], offset)
	binary.BigEndian.PutUint32(input[sha256.Size+8:], length)
	copy(input[sha256.Size+12:], digest[:])
	return sha256.Sum256(input[:])
}

// BlockPath derives a v2 staging object from its canonical file ID and offset.
func (n Namespace) BlockPath(fileID string, offset int64) (string, error) {
	if err := n.Validate(); err != nil {
		return "", err
	}
	id, err := uuid.Parse(fileID)
	if err != nil || id.String() != fileID || offset < 0 || offset%BlockSize != 0 {
		return "", fmt.Errorf("%w: invalid archive block identity", ErrInvalidNamespace)
	}
	return fmt.Sprintf("%s/files/%s/chunks/%d", n.Directory(), fileID, offset), nil
}
