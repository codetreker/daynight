package bot

import (
	"context"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

// RecoveryWorker protects the reported machine identity from concurrent Worker
// telemetry replacement until recovery and Session authorization commit.
func (b *Writer) RecoveryWorker(ctx context.Context, ownerID, workerID string) (model.WorkerMachine, error) {
	var machine model.WorkerMachine
	err := b.tx.QueryRow(ctx, `SELECT telemetry->'machine'->>'ID',telemetry->'machine'->>'Name'
 FROM workers WHERE user_id=$1 AND worker_id=$2 FOR SHARE`, ownerID, workerID).Scan(&machine.ID, &machine.Name)
	if err != nil {
		return model.WorkerMachine{}, pg.QueryError("read recovery worker machine", err)
	}
	return machine, nil
}

func (b *Writer) RegisterBotRecovery(ctx context.Context, id string, version int64, recovery model.BotRecovery) (model.Bot, error) {
	var inserted string
	err := b.tx.QueryRow(ctx, `WITH changed AS (
 UPDATE bots SET version=version+1,updated_at=statement_timestamp()
 WHERE id=$1 AND version=$2 AND version<$8 AND deletion IS NULL AND session_id IS NOT NULL
 AND role_configuration IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bot_recovery WHERE bot_id=$1)
 RETURNING id,worker_id)
 INSERT INTO bot_recovery(bot_id,worker_id,service_origin,machine_id,machine_name,identity_hash,hosting_generation)
 SELECT id,worker_id,$3,$4,$5,$6,$7 FROM changed RETURNING bot_id::text`,
		id, version, recovery.ServiceOrigin, recovery.MachineID, recovery.MachineName, recovery.IdentityHash, recovery.HostingGeneration, int64(math.MaxInt64)).Scan(&inserted)
	if err != nil {
		return model.Bot{}, pg.QueryError("register bot recovery", err)
	}
	return readBot(ctx, b.tx, id, "")
}

// AdvanceBotRecovery changes only current hosting and readiness. The original
// creation fingerprint and resolved configuration retain their frozen values.
func (b *Writer) AdvanceBotRecovery(ctx context.Context, id string, version, generation int64, workerID string, machine model.WorkerMachine) (model.Bot, error) {
	var changed string
	err := b.tx.QueryRow(ctx, `WITH changed AS (
 UPDATE bots SET version=version+1,startup_result='{"state":"pending","code":null}',updated_at=statement_timestamp()
 WHERE id=$1 AND version=$2 AND version<$7 AND deletion IS NULL
 AND EXISTS(SELECT 1 FROM bot_recovery WHERE bot_id=$1 AND hosting_generation=$3 AND hosting_generation<$7)
 RETURNING id)
 UPDATE bot_recovery SET worker_id=$4,hosting_generation=hosting_generation+1,machine_id=$5,machine_name=$6
 FROM changed WHERE bot_recovery.bot_id=changed.id AND hosting_generation=$3
 RETURNING bot_recovery.bot_id::text`, id, version, generation, workerID, machine.ID, machine.Name, int64(math.MaxInt64)).Scan(&changed)
	if err != nil {
		return model.Bot{}, pg.QueryError("advance bot recovery", err)
	}
	return readBot(ctx, b.tx, id, "")
}

func (b *Writer) BotRecoveryOperation(ctx context.Context, id, operationID string) (store.BotRecoveryOperation, error) {
	var operation store.BotRecoveryOperation
	err := b.tx.QueryRow(ctx, `SELECT operation_id::text,kind,request_hash,receipt
 FROM bot_recovery_operations WHERE bot_id=$1 AND operation_id=$2`, id, operationID).Scan(&operation.OperationID, &operation.Kind, &operation.RequestHash, &operation.Receipt)
	if err != nil {
		return store.BotRecoveryOperation{}, pg.QueryError("read bot recovery operation", err)
	}
	return operation, nil
}

func (b *Writer) SaveBotRecoveryOperation(ctx context.Context, id string, operation store.BotRecoveryOperation) error {
	_, err := b.tx.Exec(ctx, `INSERT INTO bot_recovery_operations(bot_id,operation_id,kind,request_hash,receipt)
 VALUES($1,$2,$3,$4,$5)`, id, operation.OperationID, operation.Kind, operation.RequestHash, operation.Receipt)
	if err != nil {
		return pg.QueryError("save bot recovery operation", err)
	}
	return nil
}

// BotRecoveryTokenUsed checks original receipts under the caller's Bot lock.
// Rotation never makes an earlier Controller authorization reusable.
func (b *Writer) BotRecoveryTokenUsed(ctx context.Context, id, tokenHash string) (bool, error) {
	var used bool
	err := b.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bot_recovery_operations
 WHERE bot_id=$1 AND receipt->>'controllerTokenHash'=$2)`, id, tokenHash).Scan(&used)
	if err != nil {
		return false, pg.QueryError("read used bot recovery token", err)
	}
	return used, nil
}
