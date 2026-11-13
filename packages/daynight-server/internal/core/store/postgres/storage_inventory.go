package postgres

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// OpenReadOnly validates the complete migration chain without applying DDL.
func OpenReadOnly(ctx context.Context, url string) (*Store, error) {
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, databaseFailure("configuration", err)
	}
	config.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, databaseFailure("connect", err)
	}
	connection, err := pool.Acquire(ctx)
	if err != nil {
		pool.Close()
		return nil, databaseFailure("connect", err)
	}
	count, err := appliedMigrations(ctx, connection, schemaMigrations)
	connection.Release()
	if err == nil && count != len(schemaMigrations) {
		err = errors.New("backup database requires a different reader migration version")
	}
	if err != nil {
		pool.Close()
		return nil, databaseFailure("backup reader version", err)
	}
	return &Store{Pool: pool}, nil
}

// VerifyStorageInventory holds a single read-only snapshot while it pages the
// Session inventory. It neither repairs metadata nor fetches original sources.
func (s *Store) VerifyStorageInventory(ctx context.Context, verify func(store.StorageInventory) error) (result error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	var orphan bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM (SELECT session_id FROM session_archives UNION SELECT session_id FROM session_archive_bundles UNION SELECT session_id FROM session_archive_files UNION SELECT session_id FROM session_archive_migrations) a LEFT JOIN task_sessions s ON s.id=a.session_id WHERE s.id IS NULL)`).Scan(&orphan); err != nil {
		return err
	}
	if orphan {
		return errors.New("archive metadata has no owning Session")
	}
	cursor := "00000000-0000-0000-0000-000000000000"
	for {
		rows, err := tx.Query(ctx, `SELECT s.id::text,COALESCE(s.project_id::text,''),s.owner_user_id::text,a.schema_version,a.object_path,a.sha256,a.byte_length FROM task_sessions s LEFT JOIN session_archives a ON a.session_id=s.id AND a.state='ready' WHERE s.id>$1::uuid ORDER BY s.id LIMIT 64`, cursor)
		if err != nil {
			return err
		}
		batch := []store.StorageInventory{}
		for rows.Next() {
			v := store.StorageInventory{}
			var version *int
			var path, hash *string
			var length *int64
			if err = rows.Scan(&v.SessionID, &v.ProjectID, &v.OwnerID, &version, &path, &hash, &length); err != nil {
				rows.Close()
				return err
			}
			if version != nil {
				if path == nil || hash == nil || length == nil {
					rows.Close()
					return errors.New("ready archive has incomplete storage identity")
				}
				v.Archive = &store.StorageArchive{SchemaVersion: *version, Path: *path, SHA256: *hash, ByteLength: *length}
			}
			batch = append(batch, v)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if len(batch) == 0 {
			break
		}
		for _, v := range batch {
			migration := store.ArchiveMigration{SessionID: v.SessionID}
			err = tx.QueryRow(ctx, `SELECT migration_id::text,source_path,source_hash,source_byte_length,target_path,target_hash,phase FROM session_archive_migrations WHERE session_id=$1`, v.SessionID).Scan(&migration.MigrationID, &migration.SourcePath, &migration.SourceHash, &migration.SourceLength, &migration.TargetPath, &migration.TargetHash, &migration.Phase)
			if err == nil {
				v.Migration = &migration
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			resources, err := tx.Query(ctx, `SELECT descriptor,COALESCE(blob_id::text,''),COALESCE(blob_path,''),content FROM session_resources WHERE session_id=$1 ORDER BY resource_id`, v.SessionID)
			if err != nil {
				return err
			}
			for resources.Next() {
				var raw, content []byte
				r := store.SessionResourceRecord{SessionID: v.SessionID}
				if err = resources.Scan(&raw, &r.BlobID, &r.BlobPath, &content); err != nil {
					resources.Close()
					return err
				}
				r.Resource, err = sp.DecodeResource(raw)
				if err != nil {
					resources.Close()
					return err
				}
				v.Resources = append(v.Resources, r)
				if r.BlobID == "" && r.Resource.Status == "available" {
					v.InlineResources = append(v.InlineResources, store.StorageInlineResource{Resource: r.Resource, Content: content})
				}
			}
			err = resources.Err()
			resources.Close()
			if err != nil {
				return err
			}
			objects, err := tx.Query(ctx, `SELECT 'session-archives',c.object_path,c.sha256,c.byte_length FROM session_archive_chunks c JOIN session_archive_files f USING(session_id,file_id) WHERE c.session_id=$1 AND NOT f.staging_released UNION ALL SELECT 'session-archives',object_path||'/content',sha256,byte_length FROM session_archive_files WHERE session_id=$1 AND state='complete' AND purpose='timeline'`, v.SessionID)
			if err != nil {
				return err
			}
			for objects.Next() {
				o := store.StorageObject{}
				if err = objects.Scan(&o.Bucket, &o.Path, &o.SHA256, &o.ByteLength); err != nil {
					objects.Close()
					return err
				}
				v.Objects = append(v.Objects, o)
			}
			err = objects.Err()
			objects.Close()
			if err != nil {
				return err
			}
			images, err := tx.Query(ctx, `SELECT c.blob_path,c.sha256,c.byte_length,c.chunk_offset,u.upload_id::text,u.image_id::text,u.actor_id::text,u.spec,u.receipt,u.expires_at FROM session_image_chunks c JOIN session_image_uploads u USING(session_id,upload_id) WHERE c.session_id=$1 AND NOT u.storage_released`, v.SessionID)
			if err != nil {
				return err
			}
			for images.Next() {
				o := store.StorageObject{Bucket: sessionresource.Bucket}
				var offset int64
				var upload, image, actor string
				var spec, receipt []byte
				var expiry time.Time
				if err = images.Scan(&o.Path, &o.SHA256, &o.ByteLength, &offset, &upload, &image, &actor, &spec, &receipt, &expiry); err != nil {
					images.Close()
					return err
				}
				o.Optional = pendingImageChunk(v, o, offset, upload, image, actor, spec, receipt, expiry)
				v.Objects = append(v.Objects, o)
			}
			err = images.Err()
			images.Close()
			if err != nil {
				return err
			}
			if err = verify(v); err != nil {
				return fmt.Errorf("Session %s storage closure: %w", v.SessionID, err)
			}
			cursor = v.SessionID
		}
	}
	return tx.Commit(ctx)
}

func pendingImageChunk(v store.StorageInventory, object store.StorageObject, offset int64, upload, image, actor string, rawSpec, rawReceipt []byte, expiry time.Time) bool {
	if offset != 0 || object.ByteLength < 1 || object.ByteLength > sp.MaxContentChunkBytes {
		return false
	}
	decoded, err := hex.DecodeString(object.SHA256)
	if err != nil || len(decoded) != 32 || hex.EncodeToString(decoded) != object.SHA256 {
		return false
	}
	namespace, err := sessionresource.NewNamespace(v.ProjectID, v.OwnerID, v.SessionID)
	if err != nil {
		return false
	}
	path, err := namespace.ChunkPath(upload, 0)
	if err != nil || object.Path != path {
		return false
	}
	spec, err := sp.DecodeImageUploadSpec(rawSpec)
	if err != nil || actor != v.OwnerID || spec.UploadID != upload || spec.ImageID != image || spec.Target.ActorUserID != actor || spec.Target.Fence.SessionID != v.SessionID {
		return false
	}
	length, err := strconv.ParseInt(spec.ByteLength, 10, 64)
	if err != nil || object.ByteLength > length {
		return false
	}
	fields, err := jsonobject.Decode(rawReceipt, "image upload receipt", "uploadId", "imageId", "target", "state", "acceptedOffset", "spec", "resource", "expiresAt", "error")
	if err != nil || len(fields) != 9 || string(fields["acceptedOffset"]) != `"0"` || string(fields["resource"]) != "null" {
		return false
	}
	metadata, err := jsonobject.Decode(fields["spec"], "image upload metadata", "name", "mediaType", "byteLength", "sha256")
	if err != nil || len(metadata) != 4 {
		return false
	}
	var receipt sp.ImageUploadReceipt
	if json.Unmarshal(rawReceipt, &receipt) != nil || receipt.UploadID != upload || receipt.ImageID != image || !reflect.DeepEqual(receipt.Target, spec.Target) || receipt.Spec != (sp.ImageUploadMetadata{Name: spec.Name, MediaType: spec.MediaType, ByteLength: spec.ByteLength, SHA256: spec.SHA256}) {
		return false
	}
	var receiptTarget, specTarget any
	var specFields map[string]json.RawMessage
	if json.Unmarshal(rawSpec, &specFields) != nil || json.Unmarshal(fields["target"], &receiptTarget) != nil || json.Unmarshal(specFields["target"], &specTarget) != nil || !reflect.DeepEqual(receiptTarget, specTarget) {
		return false
	}
	observedExpiry, err := time.Parse(time.RFC3339Nano, receipt.ExpiresAt)
	if err != nil || !observedExpiry.Equal(expiry) {
		return false
	}
	switch receipt.State {
	case "receiving", "released":
		return string(fields["error"]) == "null"
	case "failed", "expired":
		errorFields, err := jsonobject.Decode(fields["error"], "image error", "code", "message")
		validText := func(value string) bool {
			return utf8.ValidString(value) && len(value) <= 256 && strings.TrimFunc(value, unicode.IsSpace) != "" && !strings.ContainsRune(value, 0)
		}
		return err == nil && len(errorFields) == 2 && receipt.Error != nil && validText(receipt.Error.Code) && validText(receipt.Error.Message)
	}
	return false
}
