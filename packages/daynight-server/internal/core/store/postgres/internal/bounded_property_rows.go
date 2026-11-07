package pg

import (
	"context"
	"errors"
	"io"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/jackc/pgx/v5"
)

// propertyChunkReader never transfers more than a bounded text chunk across
// the database boundary. Character offsets preserve PostgreSQL UTF-8 text.
type propertyChunkReader struct {
	ctx          context.Context
	tx           pgx.Tx
	taskID, name string
	offset       int64
	pending      []byte
	done         bool
}

const propertyChunkCharacters = 65536

func (r *propertyChunkReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	if len(r.pending) == 0 && !r.done {
		var chunk string
		err := r.tx.QueryRow(r.ctx, `SELECT substring(value FROM $3 FOR 65536) FROM task_properties WHERE task_id=$1 AND name=$2`, r.taskID, r.name, r.offset).Scan(&chunk)
		if err != nil {
			return 0, QueryError("read task property chunk", err)
		}
		if chunk == "" {
			r.done = true
		} else {
			characters := utf8.RuneCountInString(chunk)
			r.offset += int64(characters)
			if characters < propertyChunkCharacters {
				r.done = true
			}
			r.pending = []byte(chunk)
		}
	}
	if len(r.pending) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.pending)
	r.pending = r.pending[n:]
	return n, nil
}

// LoadTaskPropertiesBounded validates and normalizes each property from bounded
// chunks; no candidate's full raw historical value is materialized first.
func LoadTaskPropertiesBounded(ctx context.Context, tx pgx.Tx, taskID string, max int64, legacy bool) (model.TaskProperties, error) {
	rows, err := tx.Query(ctx, `SELECT CASE WHEN octet_length(name)>64 THEN '' ELSE name END FROM task_properties WHERE task_id=$1 ORDER BY name LIMIT 5`, taskID)
	if err != nil {
		return nil, QueryError("read task property names", err)
	}
	var names []string
	definitions := taskproperties.Definitions()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return nil, QueryError("read task property names", err)
		}
		if _, ok := definitions[name]; !ok {
			rows.Close()
			return nil, &taskproperties.ValidationError{Path: "properties", Rule: "properties contains an unknown attribute"}
		}
		names = append(names, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, QueryError("read task property names", err)
	}
	values := model.TaskProperties{}
	var used int64
	for _, name := range names {
		reader := &propertyChunkReader{ctx: ctx, tx: tx, taskID: taskID, name: name, offset: 1}
		var value []byte
		var omitted bool
		var err error
		if legacy && name == "worker" {
			value, omitted, err = taskproperties.NormalizeStreamLegacy(ctx, name, reader, max-used)
		} else {
			value, err = taskproperties.NormalizeStream(ctx, name, reader, max-used)
		}
		var violation *limit.Violation
		if errors.As(err, &violation) {
			return nil, &model.Fault{Code: "resource_limit_exceeded", Message: "Task properties exceed the encoded resource limit.", Cause: err}
		}
		if err != nil {
			return nil, err
		}
		if !omitted {
			used += int64(len(value))
		}
		values[name] = value
	}
	return values, nil
}

// ReadTaskWorkerSummary validates a Worker value without loading its large
// text, retaining only fields needed by the inventory filter.
func ReadTaskWorkerSummary(ctx context.Context, tx pgx.Tx, taskID string) (*model.WorkerClaim, error) {
	var present bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM task_properties WHERE task_id=$1 AND name='worker')`, taskID).Scan(&present); err != nil {
		return nil, QueryError("read task worker presence", err)
	}
	if !present {
		return nil, nil
	}
	reader := &propertyChunkReader{ctx: ctx, tx: tx, taskID: taskID, name: "worker", offset: 1}
	raw, err := taskproperties.NormalizeWorkerSummary(ctx, reader)
	if err != nil {
		return nil, err
	}
	return taskproperties.Worker(model.TaskProperties{"worker": raw})
}
