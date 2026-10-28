package sessionrelay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/jackc/pgx/v5"
)

func referenced(ctx context.Context, tx pgx.Tx, id, resource string) error {
	var exists bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_timeline t, LATERAL jsonb_array_elements(COALESCE(t.entry->'content','[]'::jsonb)||COALESCE(t.entry->'output','[]'::jsonb)) part WHERE session_id=$1 AND part->>'type'='resource' AND part->>'resourceId'=$2)`, id, resource).Scan(&exists)
	if err != nil {
		return err
	}
	if !exists {
		return fault("not_found", "Resource is not referenced by session history.")
	}
	return nil
}
func readResource(ctx context.Context, tx pgx.Tx, id, resource string) ([]byte, sp.Resource, error) {
	var raw, content []byte
	var result sp.Resource
	err := tx.QueryRow(ctx, `SELECT descriptor,content FROM session_resources WHERE session_id=$1 AND resource_id=$2`, id, resource).Scan(&raw, &content)
	if err != nil {
		return nil, result, err
	}
	result, err = sp.DecodeResource(raw)
	return content, result, err
}
func (s *Service) Resource(ctx context.Context, p core.Principal, project, taskID, id, resource string) ([]byte, sp.Resource, error) {
	var content []byte
	var result sp.Resource
	err := s.browser(ctx, p, project, taskID, id, func(tx pgx.Tx, _ *record, _ task, _ bool) error {
		if err := referenced(ctx, tx, id, resource); err != nil {
			return err
		}
		var err error
		content, result, err = readResource(ctx, tx, id, resource)
		if err == nil && result.Status != "available" {
			return fault("not_found", "Resource content is not available.")
		}
		return err
	})
	return content, result, err
}
func (s *Service) PutResource(ctx context.Context, token, epoch, resource string, content []byte) (sp.Resource, error) {
	var result sp.Resource
	if len(content) > sp.MaxResourceBytes {
		return result, fault("payload_too_large", "Resource exceeds 8 MiB.")
	}
	hash := sha256.Sum256([]byte(token))
	var id string
	var expiry time.Time
	err := s.DB.Pool.QueryRow(ctx, `SELECT id::text,grant_expires_at FROM task_sessions WHERE grant_hash=$1`, hash[:]).Scan(&id, &expiry)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && !s.now().Before(expiry) {
		return result, denied()
	}
	if err != nil {
		return result, err
	}
	var f sp.ControllerFence
	err = s.DB.Pool.QueryRow(ctx, `SELECT COALESCE(snapshot->>'claimId',''),COALESCE(snapshot->>'testExecutionId',''),snapshot->>'executionGeneration' FROM task_sessions WHERE id=$1`, id).Scan(&f.ClaimID, &f.TestExecutionID, &f.ExecutionGeneration)
	if err != nil {
		return result, err
	}
	f.SessionID = id
	f.ConnectionEpoch = epoch
	err = s.controller(ctx, f, func(tx pgx.Tx, r *record, _ task) error {
		if !s.now().Before(expiry) || !equalHash(r.GrantHash, hash[:]) {
			return denied()
		}
		if err := referenced(ctx, tx, id, resource); err != nil {
			return err
		}
		old, descriptor, err := readResource(ctx, tx, id, resource)
		if err != nil {
			return err
		}
		result = descriptor
		digest := sha256.Sum256(content)
		digestText := hex.EncodeToString(digest[:])
		if result.ByteLength == nil || number(*result.ByteLength) != int64(len(content)) || result.SHA256 == nil || *result.SHA256 != digestText {
			return fault("resource_conflict", "Resource bytes do not match the declared length and hash.")
		}
		if result.Status == "available" {
			if equalHash(old, content) {
				return nil
			}
			return conflict()
		}
		if result.Status != "pending" {
			return conflict()
		}
		var used int64
		if err = tx.QueryRow(ctx, `SELECT COALESCE(sum(octet_length(content)),0) FROM session_resources WHERE session_id=$1`, id).Scan(&used); err != nil {
			return err
		}
		if used+int64(len(content)) > MaxSessionResourceBytes {
			return fault("payload_too_large", "Session resource storage exceeds 64 MiB.")
		}
		result.Status = "available"
		if result.MediaType == nil {
			mediaType := "application/octet-stream"
			result.MediaType = &mediaType
		}
		result.Error = nil
		if _, err = tx.Exec(ctx, `UPDATE session_resources SET content=$3,descriptor=$4 WHERE session_id=$1 AND resource_id=$2`, id, resource, content, encode(result)); err != nil {
			return err
		}
		if err = s.emit(ctx, tx, r, "resource", result, nil); err != nil {
			return err
		}
		return save(ctx, tx, r)
	})
	return result, err
}
func equalHash(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var difference byte
	for i := range a {
		difference |= a[i] ^ b[i]
	}
	return difference == 0
}
