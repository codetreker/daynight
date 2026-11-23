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

const workerConfigurationProjection = `configuration_revision,configuration_updated_at,desired_configuration,configuration_observation_revision,configuration_observation,archive_sessions`

func scanWorkerConfiguration(row pgx.Row) (model.WorkerConfigurationResource, error) {
	var resource model.WorkerConfigurationResource
	var revision *int64
	var updatedAt *time.Time
	var value, observation []byte
	var observationRevision int64
	var archive bool
	if err := row.Scan(&revision, &updatedAt, &value, &observationRevision, &observation, &archive); err != nil {
		return resource, err
	}
	resource.ObservationRevision = strconv.FormatInt(observationRevision, 10)
	if revision != nil {
		resource.Desired = &model.WorkerDesiredConfiguration{
			Revision: strconv.FormatInt(*revision, 10), UpdatedAt: updatedAt.UTC(),
			Raw: append(json.RawMessage(nil), value...), ArchiveSessions: &archive,
		}
		// Keep the stored target even when it no longer fits the current Go type.
		// Decode into a temporary value so a failure cannot expose a partial result.
		var decoded model.WorkerConfiguration
		if err := json.Unmarshal(value, &decoded); err == nil {
			decoded.ArchiveSessions = &archive
			resource.Desired.Value = decoded
			resource.Desired.ValueValid = true
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
	archive := true
	if value.ArchiveSessions != nil {
		archive = *value.ArchiveSessions
	}
	desired, err := w.SetWorkerConfigurationRaw(ctx, userID, workerID, revision, encoded, archive)
	if err != nil {
		return model.WorkerDesiredConfiguration{}, err
	}
	value.ArchiveSessions = &archive
	desired.Value = value
	desired.ValueValid = true
	return desired, nil
}

// SetWorkerConfigurationRaw stores a target without interpreting unrelated fields.
func (w *Writer) SetWorkerConfigurationRaw(ctx context.Context, userID, workerID string, revision int64, raw json.RawMessage, archive bool) (model.WorkerDesiredConfiguration, error) {
	desired := model.WorkerDesiredConfiguration{Revision: strconv.FormatInt(revision, 10), ArchiveSessions: &archive}
	var stored []byte
	err := w.tx.QueryRow(ctx, `UPDATE workers SET configuration_revision=$3,configuration_updated_at=statement_timestamp(),desired_configuration=$4,archive_sessions=$5 WHERE user_id=$1 AND worker_id=$2 RETURNING configuration_updated_at,desired_configuration`, userID, workerID, revision, raw, archive).Scan(&desired.UpdatedAt, &stored)
	if err != nil {
		return model.WorkerDesiredConfiguration{}, pg.QueryError("save worker configuration", err)
	}
	desired.Raw = stored
	var decoded model.WorkerConfiguration
	if err := json.Unmarshal(stored, &decoded); err == nil {
		decoded.ArchiveSessions = &archive
		desired.Value = decoded
		desired.ValueValid = true
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
