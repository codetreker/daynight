package sessionarchive

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestArchiveV2PrefixProofVectors(t *testing.T) {
	proof := InitialPrefixProof()
	check := func(want string) {
		t.Helper()
		if got := hex.EncodeToString(proof[:]); got != want {
			t.Fatalf("proof %s, want %s", got, want)
		}
	}
	check("b91b5ad7c5c0d1394346527574af27eacc308f130402f95ed8960929087ed7d2")
	block := sha256.Sum256([]byte(strings.Repeat("a", int(BlockSize))))
	proof = AdvancePrefixProof(proof, 0, uint32(BlockSize), block)
	check("801e1c004a3b470d0975b80b7d91d63b1624ca4810ad5a86e5eb48eb6577fa6e")
	block = sha256.Sum256([]byte("xyz"))
	proof = AdvancePrefixProof(proof, uint64(BlockSize), 3, block)
	check("d8f07a8f906718907977419904d7994bb013803bbeeb33bb5f7eeca41202fb40")
}

func TestArchiveV2BlockPath(t *testing.T) {
	n, err := NewNamespace(Users, "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	file := "33333333-3333-3333-3333-333333333333"
	path, err := n.BlockPath(file, BlockSize)
	if err != nil || path != n.Directory()+"/files/"+file+"/chunks/524288" {
		t.Fatalf("path %q: %v", path, err)
	}
	zero := "00000000-0000-0000-0000-000000000000"
	if _, err := n.BlockPath(zero, 0); err != nil {
		t.Fatalf("protocol file ID rejected: %v", err)
	}
	for _, tc := range []struct {
		file   string
		offset int64
	}{{"../bad", 0}, {file, -1}, {file, 1}} {
		if _, err := n.BlockPath(tc.file, tc.offset); err == nil {
			t.Fatalf("accepted invalid identity: %+v", tc)
		}
	}
}
