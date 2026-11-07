package webhook

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
)

var errRetainedMasterReferenced = errors.New("retained webhook backup still references old master")

// VerifyKeyRecovery compares the decrypted values and AAD identities in two
// independently restored, quiescent database snapshots. It also proves that
// the restored snapshot contains no reference to retiredMaster. It does not
// establish which backups are retained or whether producers have drained.
func VerifyKeyRecovery(ctx context.Context, source, restored store.WebhookRecoveryReader, sourceKeys, restoredKeys *secretbox.Keyring, retiredMaster string) (int, error) {
	return verifyKeyRecovery(ctx, source, restored, sourceKeys, restoredKeys, retiredMaster, false, nil)
}

type recoveryDatabasePair struct{ source, restored store.WebhookRecoveryIdentity }

func verifyKeyRecovery(ctx context.Context, source, restored store.WebhookRecoveryReader, sourceKeys, restoredKeys *secretbox.Keyring, retiredMaster string, retained bool, identities *recoveryDatabasePair) (_ int, resultErr error) {
	if source == nil || restored == nil || sourceKeys == nil || restoredKeys == nil || retiredMaster == "" {
		return 0, fmt.Errorf("incomplete webhook recovery verification")
	}
	if sameRecoveryReader(source, restored) {
		return 0, fmt.Errorf("recovery databases are not independent")
	}
	sourceSnapshot, err := openRecoverySnapshot(ctx, source)
	if err != nil {
		return 0, fmt.Errorf("open source recovery snapshot: %w", err)
	}
	defer func() { resultErr = errors.Join(resultErr, closeRecoverySnapshot(sourceSnapshot)) }()
	restoredSnapshot, err := openRecoverySnapshot(ctx, restored)
	if err != nil {
		return 0, fmt.Errorf("open restored recovery snapshot: %w", err)
	}
	defer func() { resultErr = errors.Join(resultErr, closeRecoverySnapshot(restoredSnapshot)) }()
	sourceIdentity, err := sourceSnapshot.RecoveryIdentity(ctx)
	if err != nil {
		return 0, fmt.Errorf("identify source recovery database: %w", err)
	}
	restoredIdentity, err := restoredSnapshot.RecoveryIdentity(ctx)
	if err != nil {
		return 0, fmt.Errorf("identify restored recovery database: %w", err)
	}
	if sourceIdentity.ClusterID == "" || sourceIdentity.DatabaseOID == 0 || restoredIdentity.ClusterID == "" || restoredIdentity.DatabaseOID == 0 {
		return 0, fmt.Errorf("invalid webhook recovery database identity")
	}
	if sourceIdentity == restoredIdentity {
		return 0, fmt.Errorf("recovery databases are not independent")
	}
	if identities != nil {
		*identities = recoveryDatabasePair{source: sourceIdentity, restored: restoredIdentity}
	}
	sourceIDs, err := sourceSnapshot.WebhookMasterKeyIDs(ctx)
	if err != nil {
		return 0, fmt.Errorf("inventory source snapshot: %w", err)
	}
	if retained {
		for _, id := range sourceIDs {
			if id == retiredMaster {
				return 0, errRetainedMasterReferenced
			}
		}
	}
	restoreIDs, err := restoredSnapshot.WebhookMasterKeyIDs(ctx)
	if err != nil {
		return 0, fmt.Errorf("inventory restored snapshot: %w", err)
	}
	for _, id := range restoreIDs {
		if id == retiredMaster {
			return 0, fmt.Errorf("restored snapshot still references retired master")
		}
	}
	count := 0
	for _, id := range sourceIDs {
		var cursor *store.WebhookCiphertext
		for {
			rows, e := sourceSnapshot.WebhookCiphertexts(ctx, id, cursor, 500)
			if e != nil {
				return count, fmt.Errorf("scan source snapshot: %w", e)
			}
			if len(rows) == 0 {
				break
			}
			for _, row := range rows {
				match, e := restoredSnapshot.WebhookCiphertextByID(ctx, row.Kind, row.ID)
				if e != nil {
					return count, fmt.Errorf("read restored snapshot: %w", e)
				}
				if match == nil || match.Kind != row.Kind || match.ID != row.ID || match.EndpointID != row.EndpointID || match.OwnerKind != row.OwnerKind || match.OwnerID != row.OwnerID || match.RecordID != row.RecordID {
					return count, fmt.Errorf("restored webhook ciphertext identity mismatch")
				}
				binding := []string{row.OwnerKind, row.OwnerID, row.EndpointID, row.Kind, row.RecordID}
				a, e := sourceKeys.Open(secretbox.Envelope{Version: row.Version, MasterKeyID: row.MasterKeyID, Nonce: row.Nonce, Ciphertext: row.Ciphertext}, binding)
				if e != nil {
					return count, fmt.Errorf("open source snapshot: %w", e)
				}
				b, e := restoredKeys.Open(secretbox.Envelope{Version: match.Version, MasterKeyID: match.MasterKeyID, Nonce: match.Nonce, Ciphertext: match.Ciphertext}, binding)
				same := e == nil && bytes.Equal(a, b)
				clear(a)
				clear(b)
				if e != nil {
					return count, fmt.Errorf("open restored snapshot: %w", e)
				}
				if !same {
					return count, fmt.Errorf("restored webhook plaintext mismatch")
				}
				count++
			}
			last := rows[len(rows)-1]
			cursor = &last
		}
	}
	total := 0
	for _, id := range restoreIDs {
		var cursor *store.WebhookCiphertext
		for {
			rows, e := restoredSnapshot.WebhookCiphertexts(ctx, id, cursor, 500)
			if e != nil {
				return count, fmt.Errorf("scan restored snapshot: %w", e)
			}
			if len(rows) == 0 {
				break
			}
			total += len(rows)
			last := rows[len(rows)-1]
			cursor = &last
		}
	}
	if total != count {
		return count, fmt.Errorf("restored webhook ciphertext count mismatch")
	}
	return count, nil
}

func closeRecoverySnapshot(snapshot store.WebhookRecoverySnapshot) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := snapshot.Close(ctx); err != nil {
		return fmt.Errorf("close webhook recovery snapshot: %w", err)
	}
	return nil
}

func recoveryDatabaseInventory(ctx context.Context, reader store.WebhookRecoveryReader) (_ store.WebhookRecoveryIdentity, _ []string, resultErr error) {
	snapshot, err := openRecoverySnapshot(ctx, reader)
	if err != nil {
		return store.WebhookRecoveryIdentity{}, nil, fmt.Errorf("open online recovery snapshot: %w", err)
	}
	defer func() { resultErr = errors.Join(resultErr, closeRecoverySnapshot(snapshot)) }()
	id, err := snapshot.RecoveryIdentity(ctx)
	if err != nil {
		return id, nil, fmt.Errorf("identify online database: %w", err)
	}
	if id.ClusterID == "" || id.DatabaseOID == 0 {
		return id, nil, fmt.Errorf("invalid online database identity")
	}
	ids, err := snapshot.WebhookMasterKeyIDs(ctx)
	if err != nil {
		return id, nil, fmt.Errorf("inventory online webhook references: %w", err)
	}
	return id, ids, nil
}

func openRecoverySnapshot(ctx context.Context, reader store.WebhookRecoveryReader) (store.WebhookRecoverySnapshot, error) {
	acquire, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return reader.OpenWebhookRecoverySnapshot(acquire)
}
