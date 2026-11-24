package worker

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

// Lifecycle binds the authority, operation ledger and observations to one
// transaction. Writers hold the existing Worker row before reading decisions.
type Lifecycle struct{ tx pgx.Tx }

func NewLifecycle(tx pgx.Tx) *Lifecycle { return &Lifecycle{tx: tx} }

var _ store.WorkerLifecycleDAO = (*Lifecycle)(nil)

func (d *Lifecycle) LockWorker(ctx context.Context, userID, workerID string) error {
	var found string
	err := d.tx.QueryRow(ctx,
		`SELECT worker_id::text FROM workers WHERE user_id=$1 AND worker_id=$2 FOR UPDATE`, userID, workerID).Scan(&found)
	if err != nil {
		return pg.QueryError("lock worker lifecycle", err)
	}
	return nil
}

func (d *Lifecycle) Lifecycle(ctx context.Context, userID, workerID string) (model.WorkerLifecycle, error) {
	v := model.WorkerLifecycle{UserID: userID, WorkerID: workerID}
	err := d.tx.QueryRow(ctx, `SELECT protocol_version,intent_version,desired,admission,current_operation_id::text,
		instance_id::text,capability_version,bootstrap_consumed,reconnect_allowed,updated_at
		FROM worker_lifecycle WHERE user_id=$1 AND worker_id=$2`, userID, workerID).Scan(
		&v.ProtocolVersion, &v.IntentVersion, &v.Desired, &v.Admission, &v.CurrentOperationID,
		&v.InstanceID, &v.CapabilityVersion, &v.BootstrapConsumed, &v.ReconnectAllowed, &v.UpdatedAt)
	if err != nil {
		return v, pg.QueryError("read worker lifecycle", err)
	}
	v.UpdatedAt = v.UpdatedAt.UTC()
	return v, nil
}

func (d *Lifecycle) SaveLifecycle(ctx context.Context, v model.WorkerLifecycle) error {
	_, err := d.tx.Exec(ctx, `INSERT INTO worker_lifecycle
		(user_id,worker_id,protocol_version,intent_version,desired,admission,current_operation_id,instance_id,
		capability_version,bootstrap_consumed,reconnect_allowed,updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		ON CONFLICT (user_id,worker_id) DO UPDATE SET protocol_version=EXCLUDED.protocol_version,
		intent_version=EXCLUDED.intent_version,desired=EXCLUDED.desired,admission=EXCLUDED.admission,
		current_operation_id=EXCLUDED.current_operation_id,instance_id=EXCLUDED.instance_id,
		capability_version=EXCLUDED.capability_version,
		bootstrap_consumed=EXCLUDED.bootstrap_consumed,reconnect_allowed=EXCLUDED.reconnect_allowed,updated_at=EXCLUDED.updated_at`,
		v.UserID, v.WorkerID, v.ProtocolVersion, v.IntentVersion, v.Desired, v.Admission, v.CurrentOperationID, v.InstanceID,
		v.CapabilityVersion, v.BootstrapConsumed, v.ReconnectAllowed, v.UpdatedAt)
	if err != nil {
		return pg.QueryError("save worker lifecycle", err)
	}
	return nil
}

func (d *Lifecycle) Operation(ctx context.Context, userID, workerID, operationID string) (model.LifecycleOperation, error) {
	v := model.LifecycleOperation{UserID: userID, WorkerID: workerID, OperationID: operationID}
	err := d.tx.QueryRow(ctx, `SELECT action,source,request_kind,request_hash,request,intent_version,state,receipt,
		activation,activation_request,activation_hash,activation_outcome,error_code,created_at,updated_at
		FROM worker_lifecycle_operations WHERE user_id=$1 AND worker_id=$2 AND operation_id=$3`, userID, workerID, operationID).Scan(
		&v.Action, &v.Source, &v.RequestKind, &v.RequestHash, &v.Request, &v.IntentVersion, &v.State, &v.Receipt,
		&v.Activation, &v.ActivationRequest, &v.ActivationHash, &v.ActivationOutcome, &v.ErrorCode, &v.CreatedAt, &v.UpdatedAt)
	if err != nil {
		return v, pg.QueryError("read worker lifecycle operation", err)
	}
	v.CreatedAt, v.UpdatedAt = v.CreatedAt.UTC(), v.UpdatedAt.UTC()
	return v, nil
}

func (d *Lifecycle) SaveOperation(ctx context.Context, v model.LifecycleOperation) error {
	result, err := d.tx.Exec(ctx, `INSERT INTO worker_lifecycle_operations
		(user_id,worker_id,operation_id,action,source,request_kind,request_hash,request,intent_version,state,receipt,
		activation,activation_request,activation_hash,activation_outcome,error_code,created_at,updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
		ON CONFLICT (user_id,worker_id,operation_id) DO UPDATE SET state=EXCLUDED.state,receipt=EXCLUDED.receipt,
		activation=EXCLUDED.activation,activation_request=EXCLUDED.activation_request,activation_hash=EXCLUDED.activation_hash,
		activation_outcome=EXCLUDED.activation_outcome,error_code=EXCLUDED.error_code,updated_at=EXCLUDED.updated_at
		WHERE worker_lifecycle_operations.request_hash=EXCLUDED.request_hash
		AND worker_lifecycle_operations.request=EXCLUDED.request
		AND worker_lifecycle_operations.request_kind=EXCLUDED.request_kind`,
		v.UserID, v.WorkerID, v.OperationID, v.Action, v.Source, v.RequestKind, v.RequestHash, v.Request, v.IntentVersion, v.State, v.Receipt,
		v.Activation, v.ActivationRequest, v.ActivationHash, v.ActivationOutcome, v.ErrorCode, v.CreatedAt, v.UpdatedAt)
	if err != nil {
		return pg.QueryError("save worker lifecycle operation", err)
	}
	if result.RowsAffected() != 1 {
		return &model.Fault{Code: "operation_conflict", Message: "The lifecycle operation has a different request."}
	}
	return nil
}

func (d *Lifecycle) Observation(ctx context.Context, userID, workerID string) (model.LifecycleStoredObservation, error) {
	v := model.LifecycleStoredObservation{UserID: userID, WorkerID: workerID}
	var raw []byte
	if err := d.tx.QueryRow(ctx, `SELECT observation,received_at FROM worker_lifecycle_observations WHERE user_id=$1 AND worker_id=$2`,
		userID, workerID).Scan(&raw, &v.ReceivedAt); err != nil {
		return v, pg.QueryError("read worker lifecycle observation", err)
	}
	if err := json.Unmarshal(raw, &v.Envelope); err != nil {
		return v, fmt.Errorf("decode worker lifecycle observation: %w", err)
	}
	v.ReceivedAt = v.ReceivedAt.UTC()
	return v, nil
}

func (d *Lifecycle) SaveObservation(ctx context.Context, v model.LifecycleStoredObservation) error {
	raw, err := json.Marshal(v.Envelope)
	if err != nil {
		return fmt.Errorf("encode worker lifecycle observation: %w", err)
	}
	e := v.Envelope
	_, err = d.tx.Exec(ctx, `INSERT INTO worker_lifecycle_observations
		(user_id,worker_id,intent_version,local_epoch,scope_generation,report_sequence,observation,received_at)
		VALUES ($1,$2,$3::text::bigint,$4::text::bigint,$5::text::bigint,$6::text::bigint,$7,$8)
		ON CONFLICT (user_id,worker_id) DO UPDATE SET intent_version=EXCLUDED.intent_version,
		local_epoch=EXCLUDED.local_epoch,scope_generation=EXCLUDED.scope_generation,report_sequence=EXCLUDED.report_sequence,
		observation=EXCLUDED.observation,received_at=EXCLUDED.received_at`,
		v.UserID, v.WorkerID, e.IntentVersion, e.LocalEpoch, e.ScopeGeneration, e.ReportSequence, raw, v.ReceivedAt)
	if err != nil {
		return pg.QueryError("save worker lifecycle observation", err)
	}
	return nil
}

func (d *Lifecycle) DeleteObservation(ctx context.Context, userID, workerID string) error {
	_, err := d.tx.Exec(ctx, `DELETE FROM worker_lifecycle_observations WHERE user_id=$1 AND worker_id=$2`, userID, workerID)
	if err != nil {
		return pg.QueryError("delete worker lifecycle observation", err)
	}
	return nil
}
