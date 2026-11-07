package webhook

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
)

// ProducerObservation is issued by the deployment controller for an instance
// in its authoritative inventory. Done is closed only after the process has
// exited and all of its writes have drained.
type ProducerObservation struct {
	ID, ActiveMasterID string
	Done               <-chan struct{}
}

// RecoverySnapshot identifies one retained backup and two independently
// restored, quiescent copies of that same backup. Source is not a temporary
// pre-rewrap baseline: it must represent the backup still retained by the
// backup controller, and must itself no longer reference the retired key.
type RecoverySnapshot struct {
	ID                       string
	Source, Restored         store.WebhookRecoveryReader
	SourceKeys, RestoredKeys *secretbox.Keyring
}

// RetirementInventory is supplied by the deployment and backup controllers.
// They must enumerate the complete retained set and hold the deployment barrier
// preventing old-active producers from restarting through the decision.
type RetirementInventory interface {
	Producers(context.Context) ([]ProducerObservation, error)
	Backups(context.Context) ([]RecoverySnapshot, error)
}

type RetirementResult struct {
	Safe                         bool
	Producers, Backups, Compared int
}

// AssessKeyRetirement verifies observed process exits, all supplied recovery
// snapshots and a final live scan. Absent or changed inventory is not evidence.
// Only a controller that owns complete inventory and holds the no-restart
// barrier can use a true result to retire the master.
func AssessKeyRetirement(ctx context.Context, old string, online store.WebhookRecoveryReader, inventory RetirementInventory) (RetirementResult, error) {
	var result RetirementResult
	if old == "" || online == nil || inventory == nil {
		return result, fmt.Errorf("incomplete retirement inventory")
	}
	producers, err := inventory.Producers(ctx)
	if err != nil {
		return result, fmt.Errorf("observe webhook producers: %w", err)
	}
	backups, err := inventory.Backups(ctx)
	if err != nil {
		return result, fmt.Errorf("observe webhook backups: %w", err)
	}
	if len(producers) == 0 || len(backups) == 0 {
		return result, nil
	}
	seen := make(map[string]ProducerObservation, len(producers))
	for _, p := range producers {
		if p.ID == "" || p.ActiveMasterID == "" || p.Done == nil {
			return result, fmt.Errorf("invalid webhook producer observation")
		}
		if _, ok := seen[p.ID]; ok {
			return result, fmt.Errorf("duplicate webhook producer")
		}
		seen[p.ID] = p
		if p.ActiveMasterID == old {
			select {
			case <-p.Done:
			default:
				return result, nil
			}
		}
	}
	result.Producers = len(producers)
	backupIDs := make(map[string]RecoverySnapshot, len(backups))
	backupIdentities := make([]recoveryDatabasePair, 0, len(backups))
	for _, b := range backups {
		if b.ID == "" {
			return result, fmt.Errorf("invalid webhook backup identity")
		}
		if _, ok := backupIDs[b.ID]; ok {
			return result, fmt.Errorf("duplicate webhook backup")
		}
		backupIDs[b.ID] = b
		if b.Source == nil || b.Restored == nil || sameRecoveryReader(b.Source, b.Restored) {
			return result, fmt.Errorf("independent retained backup copies are required")
		}
		var pair recoveryDatabasePair
		n, e := verifyKeyRecovery(ctx, b.Source, b.Restored, b.SourceKeys, b.RestoredKeys, old, true, &pair)
		if errors.Is(e, errRetainedMasterReferenced) {
			return result, nil
		}
		if e != nil {
			return result, fmt.Errorf("verify retained webhook backup: %w", e)
		}
		result.Compared += n
		backupIdentities = append(backupIdentities, pair)
	}
	result.Backups = len(backups)
	onlineIdentity, ids, err := recoveryDatabaseInventory(ctx, online)
	if err != nil {
		return result, err
	}
	for _, pair := range backupIdentities {
		if pair.source == onlineIdentity || pair.restored == onlineIdentity {
			return result, fmt.Errorf("retained backup databases must be independent of online database")
		}
	}
	for _, id := range ids {
		if id == old {
			return result, nil
		}
	}
	again, err := inventory.Producers(ctx)
	if err != nil {
		return result, fmt.Errorf("recheck webhook producers: %w", err)
	}
	if len(again) != len(seen) {
		return result, nil
	}
	for _, p := range again {
		prev, ok := seen[p.ID]
		if !ok || prev.ActiveMasterID != p.ActiveMasterID || prev.Done != p.Done {
			return result, nil
		}
		delete(seen, p.ID)
	}
	if len(seen) != 0 {
		return result, nil
	}
	currentBackups, err := inventory.Backups(ctx)
	if err != nil {
		return result, fmt.Errorf("recheck webhook backups: %w", err)
	}
	if len(currentBackups) != len(backupIDs) {
		return result, nil
	}
	for _, b := range currentBackups {
		previous, ok := backupIDs[b.ID]
		if !ok || !sameRecoveryReader(previous.Source, b.Source) || !sameRecoveryReader(previous.Restored, b.Restored) || previous.SourceKeys != b.SourceKeys || previous.RestoredKeys != b.RestoredKeys {
			return result, nil
		}
		delete(backupIDs, b.ID)
	}
	if len(backupIDs) != 0 {
		return result, nil
	}
	result.Safe = true
	return result, nil
}

func sameRecoveryReader(a, b store.WebhookRecoveryReader) bool {
	if a == nil || b == nil {
		return false
	}
	av, bv := reflect.ValueOf(a), reflect.ValueOf(b)
	return av.Type() == bv.Type() && av.Comparable() && bv.Comparable() && av.Interface() == bv.Interface()
}
