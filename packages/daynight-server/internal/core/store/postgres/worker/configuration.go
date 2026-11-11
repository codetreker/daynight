package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
	"github.com/jackc/pgx/v5"
)

const workerConfigurationProjection = `configuration_revision,configuration_updated_at,desired_configuration,configuration_observation_revision,configuration_observation`

func scanWorkerConfiguration(row pgx.Row) (model.WorkerConfigurationResource, error) {
	var resource model.WorkerConfigurationResource
	var revision *int64
	var updatedAt *time.Time
	var value, observation []byte
	var observationRevision int64
	if err := row.Scan(&revision, &updatedAt, &value, &observationRevision, &observation); err != nil {
		return resource, err
	}
	resource.ObservationRevision = strconv.FormatInt(observationRevision, 10)
	if revision != nil {
		resource.Desired = &model.WorkerDesiredConfiguration{Revision: strconv.FormatInt(*revision, 10), UpdatedAt: updatedAt.UTC()}
		// Historical JSONB omits agentControlMode and toolPaths. Nil choices mean not adopted;
		// neither storage reads nor observation reads supply a default or evidence.
		if err := json.Unmarshal(value, &resource.Desired.Value); err != nil {
			return resource, err
		}
	}
	if observation != nil {
		decoded, err := workerprotocol.DecodeStoredObservation(observation)
		if err != nil {
			return resource, err
		}
		resource.Observation = decoded
	}
	return resource, nil
}

func (s *Reader) WorkerConfiguration(ctx context.Context, userID, workerID string) (model.WorkerConfigurationResource, error) {
	value, err := scanWorkerConfiguration(s.tx.QueryRow(ctx, `SELECT `+workerConfigurationProjection+` FROM workers WHERE user_id=$1 AND worker_id=$2`, userID, workerID))
	if err != nil {
		return model.WorkerConfigurationResource{}, pg.QueryError("read worker configuration", err)
	}
	return value, nil
}

func (w *Writer) WorkerConfiguration(ctx context.Context, userID, workerID string) (model.WorkerConfigurationResource, error) {
	value, err := scanWorkerConfiguration(w.tx.QueryRow(ctx, `SELECT `+workerConfigurationProjection+` FROM workers WHERE user_id=$1 AND worker_id=$2 FOR UPDATE`, userID, workerID))
	if err != nil {
		return model.WorkerConfigurationResource{}, pg.QueryError("lock worker configuration", err)
	}
	return value, nil
}

func (w *Writer) ConfigurationProjectAccess(ctx context.Context, userID, projectID string) error {
	_, err := pg.ReadProjectAccess(ctx, w.tx, userID, projectID)
	return err
}

func (w *Writer) SetWorkerConfiguration(ctx context.Context, userID, workerID string, revision int64, value model.WorkerConfiguration) (model.WorkerDesiredConfiguration, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return model.WorkerDesiredConfiguration{}, pg.QueryError("encode worker configuration", err)
	}
	desired := model.WorkerDesiredConfiguration{Revision: strconv.FormatInt(revision, 10), Value: value}
	err = w.tx.QueryRow(ctx, `UPDATE workers SET configuration_revision=$3,configuration_updated_at=statement_timestamp(),desired_configuration=$4 WHERE user_id=$1 AND worker_id=$2 RETURNING configuration_updated_at`, userID, workerID, revision, encoded).Scan(&desired.UpdatedAt)
	if err != nil {
		return model.WorkerDesiredConfiguration{}, pg.QueryError("save worker configuration", err)
	}
	desired.UpdatedAt = desired.UpdatedAt.UTC()
	return desired, nil
}

func (w *Writer) SetWorkerConfigurationObservation(ctx context.Context, userID, workerID string, revision int64, value model.WorkerConfigurationObservation) error {
	reportedAt, err := w.ObservedAt(ctx)
	if err != nil {
		return err
	}
	var encoded bytes.Buffer
	_, err = workerprotocol.EncodeObservation(&encoded, model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: value, ReportedAt: reportedAt}, math.MaxInt64)
	if err != nil {
		return pg.QueryError("encode worker configuration observation", err)
	}
	_, err = w.tx.Exec(ctx, `UPDATE workers SET configuration_observation_revision=$3,configuration_observation=$4 WHERE user_id=$1 AND worker_id=$2`, userID, workerID, revision, encoded.Bytes())
	if err != nil {
		return pg.QueryError("save worker configuration observation", err)
	}
	return nil
}
