package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const attachmentMigrationPrefix = ".attachment-layout-"
const attachmentMigrationLock int64 = 0x444e4154544c4159

type AttachmentMigrationSummary struct {
	OperationID       string  `json:"operationId"`
	Phase             string  `json:"phase"`
	TaskCount         int     `json:"taskCount"`
	FileCount         int     `json:"fileCount"`
	TotalBytes        int64   `json:"totalBytes"`
	UnregisteredCount int     `json:"unregisteredCount"`
	ManifestPath      string  `json:"manifestPath"`
	ReceiptPath       *string `json:"receiptPath"`
}

// AttachmentMigrationError exposes a safe diagnostic while retaining the filesystem or database cause.
type AttachmentMigrationError struct {
	OperationID string
	Phase       string
	Category    string
	Diagnostic  string
	ProjectID   string
	TaskID      string
	Cause       error
}

func (e *AttachmentMigrationError) Error() string { return e.Diagnostic }
func (e *AttachmentMigrationError) Unwrap() error { return e.Cause }

type attachmentMigrationIdentity struct {
	Database    string            `json:"database"`
	Schema      string            `json:"schema"`
	Relations   map[string]string `json:"relations"`
	Fingerprint string            `json:"fingerprint"`
}

type attachmentMigrationOwner struct {
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
}

type attachmentMigrationMetadata struct {
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	Data      string `json:"metadata"`
}

type attachmentMigrationEntry struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256,omitempty"`
}

type attachmentMigrationTask struct {
	ProjectID string                     `json:"projectId"`
	TaskID    string                     `json:"taskId"`
	Exists    bool                       `json:"exists"`
	Entries   []attachmentMigrationEntry `json:"entries"`
}

type attachmentMigrationManifest struct {
	Version        int                           `json:"version"`
	OperationID    string                        `json:"operationId"`
	Identity       attachmentMigrationIdentity   `json:"databaseIdentity"`
	DatabaseDigest string                        `json:"databaseDigest"`
	BucketExists   bool                          `json:"bucketExists"`
	Owners         []attachmentMigrationOwner    `json:"owners"`
	Metadata       []attachmentMigrationMetadata `json:"attachments"`
	Tasks          []attachmentMigrationTask     `json:"tasks"`
}

type attachmentMigrationState struct {
	Version        int    `json:"version"`
	OperationID    string `json:"operationId"`
	ManifestSHA256 string `json:"manifestSha256"`
	Phase          string `json:"phase"`
}

type attachmentMigrationReceipt struct {
	AttachmentMigrationSummary
	ManifestSHA256 string `json:"manifestSha256"`
	DatabaseDigest string `json:"databaseDigest"`
}

type attachmentMigrationSnapshot struct {
	identity attachmentMigrationIdentity
	digest   string
	owners   []attachmentMigrationOwner
	metadata []attachmentMigrationMetadata
}

type attachmentMigration struct {
	root      *os.Root
	database  *pgx.Conn
	config    *pgx.ConnConfig
	logger    *slog.Logger
	operation string
	phase     string
}

// MigrateAttachmentLayout requires all HTTP, direct database, and file writers to remain stopped.
// Its advisory lock serializes maintenance calls; it does not fence ordinary application writes.
func MigrateAttachmentLayout(ctx context.Context, databaseURL, storageRoot, action, operationID string, logger *slog.Logger) (AttachmentMigrationSummary, error) {
	m := &attachmentMigration{logger: logger, phase: "configuration"}
	if action != "plan" && action != "apply" && action != "resume" {
		return AttachmentMigrationSummary{}, m.failure("invalid_input", "Migration action must be plan, apply, or resume.", nil)
	}
	if action == "plan" {
		if operationID != "" {
			return AttachmentMigrationSummary{}, m.failure("invalid_input", "A new migration plan cannot specify an operation ID.", nil)
		}
	} else {
		id, err := CanonicalID(operationID)
		if err != nil {
			return AttachmentMigrationSummary{}, m.failure("invalid_input", "A valid migration operation ID is required.", err)
		}
		m.operation = id
	}
	if strings.TrimSpace(databaseURL) == "" || strings.TrimSpace(storageRoot) == "" {
		return AttachmentMigrationSummary{}, m.failure("configuration", "DAYNIGHT_DATABASE_URL and DAYNIGHT_STORAGE_ROOT are required.", nil)
	}
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return AttachmentMigrationSummary{}, m.failure("database", "Migration database configuration is invalid.", err)
	}
	m.config = config
	m.database, err = pgx.ConnectConfig(ctx, config)
	if err != nil {
		return AttachmentMigrationSummary{}, m.failure("database", "Migration database connection failed.", err)
	}
	defer m.database.Close(context.Background())
	if _, err := m.database.Exec(ctx, "SELECT pg_advisory_lock($1)", attachmentMigrationLock); err != nil {
		return AttachmentMigrationSummary{}, m.failure("database", "Migration ownership lock failed.", err)
	}
	m.root, err = os.OpenRoot(storageRoot)
	if err != nil {
		return AttachmentMigrationSummary{}, m.failure("filesystem", "Migration storage root could not be opened.", err)
	}
	defer m.root.Close()
	m.phase = "inventory"
	if err := m.inspectOperations(ctx, action == "plan"); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	if action == "plan" {
		return m.plan(ctx)
	}
	return m.apply(ctx, action == "resume")
}

func (m *attachmentMigration) failure(category, diagnostic string, cause error) error {
	return &AttachmentMigrationError{OperationID: m.operation, Phase: m.phase, Category: category, Diagnostic: diagnostic, Cause: cause}
}

func (m *attachmentMigration) event(ctx context.Context, phase, step string, owner attachmentMigrationOwner) {
	m.logger.InfoContext(ctx, "attachment layout migration", "component", "attachment_layout_migration", "operationId", m.operation,
		"phase", phase, "step", step, "projectId", owner.ProjectID, "taskId", owner.TaskID)
}

func (m *attachmentMigration) directory() string { return attachmentMigrationPrefix + m.operation }

func (m *attachmentMigration) inspectOperations(ctx context.Context, planning bool) error {
	entries, err := m.readDirectory(ctx, ".")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), attachmentMigrationPrefix) {
			continue
		}
		id := strings.TrimPrefix(entry.Name(), attachmentMigrationPrefix)
		canonical, err := CanonicalID(id)
		if err != nil || canonical != id || !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return m.failure("operation_conflict", "An unrecognized migration operation entry requires inspection.", err)
		}
		if id == m.operation && !planning {
			continue
		}
		var state attachmentMigrationState
		if _, err := m.readJSON(entry.Name()+"/state.json", &state); err != nil || state.Phase != "complete" {
			return &AttachmentMigrationError{OperationID: id, Phase: m.phase, Category: "resume_required", Diagnostic: "An unfinished migration operation requires explicit resume.", Cause: err}
		}
		if planning {
			return &AttachmentMigrationError{OperationID: id, Phase: m.phase, Category: "already_migrated", Diagnostic: "A completed migration operation exists; verify that operation instead of creating another plan."}
		}
	}
	return nil
}

func (m *attachmentMigration) snapshot(ctx context.Context) (attachmentMigrationSnapshot, error) {
	result := attachmentMigrationSnapshot{owners: []attachmentMigrationOwner{}, metadata: []attachmentMigrationMetadata{}}
	tx, err := m.database.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return result, m.failure("database", "Migration metadata snapshot could not be opened.", err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, "SET LOCAL TIME ZONE 'UTC'"); err != nil {
		return result, m.failure("database", "Migration snapshot time zone could not be set.", err)
	}
	var databaseOID string
	identity := attachmentMigrationIdentity{Relations: map[string]string{}}
	if err := tx.QueryRow(ctx, `SELECT current_database(), current_schema(), (SELECT oid::text FROM pg_database WHERE datname=current_database())`).Scan(&identity.Database, &identity.Schema, &databaseOID); err != nil {
		return result, m.failure("database", "Migration database identity could not be read.", err)
	}
	for _, name := range []string{"projects", "tasks", "task_attachments"} {
		var schema, oid string
		if err := tx.QueryRow(ctx, `SELECT n.nspname, c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)`, name).Scan(&schema, &oid); err != nil {
			return result, m.failure("database", "Migration source tables could not be identified.", err)
		}
		identity.Relations[name] = schema + "/" + oid
	}
	identityData, err := json.Marshal([]any{m.config.Host, strconv.Itoa(int(m.config.Port)), identity.Database, databaseOID, identity.Schema, identity.Relations})
	if err != nil {
		return result, m.failure("inventory", "Migration database identity could not be encoded.", err)
	}
	identity.Fingerprint = attachmentMigrationDigest(identityData)
	result.identity = identity
	digest := sha256.New()
	projects := map[string]bool{}
	rows, err := tx.Query(ctx, `SELECT id::text, to_jsonb(p)::text FROM projects p ORDER BY id`)
	if err != nil {
		return result, m.failure("database", "Migration projects could not be read.", err)
	}
	for rows.Next() {
		var id, data string
		if err := rows.Scan(&id, &data); err != nil {
			rows.Close()
			return result, m.failure("database", "Migration project row could not be decoded.", err)
		}
		projects[id] = true
		fmt.Fprintln(digest, "projects", data)
	}
	if err := rows.Err(); err != nil {
		return result, m.failure("database", "Migration project inventory failed.", err)
	}
	rows, err = tx.Query(ctx, `SELECT id::text, project_id::text, to_jsonb(t)::text FROM tasks t ORDER BY id`)
	if err != nil {
		return result, m.failure("database", "Migration tasks could not be read.", err)
	}
	owners := map[string]string{}
	for rows.Next() {
		var owner attachmentMigrationOwner
		var data string
		if err := rows.Scan(&owner.TaskID, &owner.ProjectID, &data); err != nil {
			rows.Close()
			return result, m.failure("database", "Migration task row could not be decoded.", err)
		}
		if !projects[owner.ProjectID] {
			rows.Close()
			return result, m.failure("ownership", "A migration task references a missing project.", nil)
		}
		owners[owner.TaskID] = owner.ProjectID
		result.owners = append(result.owners, owner)
		fmt.Fprintln(digest, "tasks", data)
	}
	if err := rows.Err(); err != nil {
		return result, m.failure("database", "Migration task inventory failed.", err)
	}
	rows, err = tx.Query(ctx, `SELECT project_id::text, task_id::text, path, size_bytes, to_jsonb(a)::text FROM task_attachments a ORDER BY task_id, path COLLATE "C"`)
	if err != nil {
		return result, m.failure("database", "Migration attachment metadata could not be read.", err)
	}
	for rows.Next() {
		var metadata attachmentMigrationMetadata
		var data string
		if err := rows.Scan(&metadata.ProjectID, &metadata.TaskID, &metadata.Path, &metadata.SizeBytes, &data); err != nil {
			rows.Close()
			return result, m.failure("database", "Migration attachment row could not be decoded.", err)
		}
		if owners[metadata.TaskID] != metadata.ProjectID {
			rows.Close()
			return result, m.failure("ownership", "Attachment metadata has no matching project and task owner.", nil)
		}
		if err := filestorage.ValidateAddress(attachmentBucket, metadata.Path); err != nil || metadata.SizeBytes < 0 {
			rows.Close()
			return result, m.failure("invalid_metadata", "Attachment metadata contains an invalid relative path or size.", err)
		}
		metadata.Data = data
		result.metadata = append(result.metadata, metadata)
		fmt.Fprintln(digest, "task_attachments", data)
	}
	if err := rows.Err(); err != nil {
		return result, m.failure("database", "Migration attachment inventory failed.", err)
	}
	result.digest = hex.EncodeToString(digest.Sum(nil))
	if err := tx.Commit(ctx); err != nil {
		return result, m.failure("database", "Migration metadata snapshot could not be closed.", err)
	}
	return result, nil
}

func attachmentMigrationDigest(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func (m *attachmentMigration) checkSnapshot(ctx context.Context, manifest attachmentMigrationManifest) error {
	current, err := m.snapshot(ctx)
	if err != nil {
		return err
	}
	if current.digest != manifest.DatabaseDigest || !reflect.DeepEqual(current.identity, manifest.Identity) || !slices.Equal(current.owners, manifest.Owners) || !reflect.DeepEqual(current.metadata, manifest.Metadata) {
		return m.failure("metadata_changed", "The migration database identity or business metadata differs from the plan.", nil)
	}
	return nil
}

func (m *attachmentMigration) plan(ctx context.Context) (AttachmentMigrationSummary, error) {
	snapshot, err := m.snapshot(ctx)
	if err != nil {
		return AttachmentMigrationSummary{}, err
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return AttachmentMigrationSummary{}, m.failure("operation", "A migration operation ID could not be generated.", err)
	}
	m.operation = id.String()
	manifest := attachmentMigrationManifest{Version: 1, OperationID: m.operation, Identity: snapshot.identity, DatabaseDigest: snapshot.digest,
		Owners: snapshot.owners, Metadata: snapshot.metadata, Tasks: []attachmentMigrationTask{}}
	bucket, err := m.inspectDirectory(attachmentBucket)
	if err != nil {
		return AttachmentMigrationSummary{}, err
	}
	manifest.BucketExists = bucket
	directories := map[string]bool{}
	if bucket {
		entries, err := m.readDirectory(ctx, attachmentBucket)
		if err != nil {
			return AttachmentMigrationSummary{}, err
		}
		for _, entry := range entries {
			id, err := CanonicalID(entry.Name())
			if err != nil || id != entry.Name() || !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
				return AttachmentMigrationSummary{}, m.failure("unsafe_entry", "The legacy attachment bucket contains an invalid task directory.", err)
			}
			directories[id] = true
		}
	}
	for _, owner := range snapshot.owners {
		task := attachmentMigrationTask{ProjectID: owner.ProjectID, TaskID: owner.TaskID, Exists: directories[owner.TaskID], Entries: []attachmentMigrationEntry{}}
		if task.Exists {
			task.Entries, err = m.inventory(ctx, attachmentBucket+"/"+task.TaskID, true)
			if err != nil {
				return AttachmentMigrationSummary{}, err
			}
			delete(directories, owner.TaskID)
		}
		manifest.Tasks = append(manifest.Tasks, task)
	}
	if len(directories) != 0 {
		return AttachmentMigrationSummary{}, m.failure("ownership", "A legacy task directory has no database owner.", nil)
	}
	if err := m.validateManifest(manifest); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	if err := m.root.Mkdir(m.directory(), 0o700); err != nil {
		return AttachmentMigrationSummary{}, m.failure("filesystem", "The migration operation directory could not be created.", err)
	}
	if err := m.syncDirectory("."); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	hash, err := m.writeJSON(m.directory()+"/manifest.json", manifest, false)
	if err != nil {
		return AttachmentMigrationSummary{}, err
	}
	if err := m.saveState("planned", hash); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	m.event(ctx, "planned", "plan_created", attachmentMigrationOwner{})
	return manifest.summary("planned"), nil
}

func (manifest attachmentMigrationManifest) summary(phase string) AttachmentMigrationSummary {
	result := AttachmentMigrationSummary{OperationID: manifest.OperationID, Phase: phase, ManifestPath: attachmentMigrationPrefix + manifest.OperationID + "/manifest.json"}
	for _, task := range manifest.Tasks {
		if task.Exists {
			result.TaskCount++
		}
		for _, entry := range task.Entries {
			if entry.Kind == "file" {
				result.FileCount++
				result.TotalBytes += entry.Size
			}
		}
	}
	result.UnregisteredCount = result.FileCount - len(manifest.Metadata)
	if phase == "complete" {
		path := attachmentMigrationPrefix + manifest.OperationID + "/receipt.json"
		result.ReceiptPath = &path
	}
	return result
}

func (m *attachmentMigration) validateManifest(manifest attachmentMigrationManifest) error {
	if manifest.Version != 1 || manifest.OperationID != m.operation || manifest.DatabaseDigest == "" || manifest.Identity.Fingerprint == "" {
		return m.failure("invalid_manifest", "The migration manifest identity is invalid.", nil)
	}
	tasks := map[string]attachmentMigrationTask{}
	indexed := map[string]map[string]attachmentMigrationEntry{}
	for _, task := range manifest.Tasks {
		project, projectErr := CanonicalID(task.ProjectID)
		id, taskErr := CanonicalID(task.TaskID)
		if projectErr != nil || taskErr != nil || project != task.ProjectID || id != task.TaskID {
			return m.failure("invalid_manifest", "The migration manifest contains an invalid task identity.", errors.Join(projectErr, taskErr))
		}
		if _, exists := tasks[task.TaskID]; exists {
			return m.failure("invalid_manifest", "The migration manifest contains duplicate task identities.", nil)
		}
		entries := map[string]attachmentMigrationEntry{}
		for _, entry := range task.Entries {
			if entry.Path != "." {
				if err := filestorage.ValidateAddress(attachmentBucket, entry.Path); err != nil {
					return m.failure("invalid_manifest", "The migration manifest contains an invalid relative entry.", err)
				}
			}
			if _, exists := entries[entry.Path]; exists {
				return m.failure("invalid_manifest", "The migration manifest contains duplicate directory entries.", nil)
			}
			if entry.Kind != "directory" && entry.Kind != "file" || entry.Size < 0 || entry.Kind == "directory" && (entry.Size != 0 || entry.SHA256 != "") || entry.Kind == "file" && !attachmentMigrationHashValid(entry.SHA256) {
				return m.failure("invalid_manifest", "The migration manifest contains an invalid entry type, size, or checksum.", nil)
			}
			entries[entry.Path] = entry
		}
		if task.Exists {
			if entry, exists := entries["."]; !exists || entry.Kind != "directory" {
				return m.failure("invalid_manifest", "The migration manifest is missing an existing task root.", nil)
			}
		} else if len(entries) != 0 {
			return m.failure("invalid_manifest", "The migration manifest assigns entries to an absent task root.", nil)
		}
		tasks[task.TaskID] = task
		indexed[task.TaskID] = entries
	}
	if len(tasks) != len(manifest.Owners) {
		return m.failure("invalid_manifest", "The migration task inventory does not match its owner inventory.", nil)
	}
	for _, owner := range manifest.Owners {
		if task, exists := tasks[owner.TaskID]; !exists || task.ProjectID != owner.ProjectID {
			return m.failure("invalid_manifest", "The migration task inventory has contradictory ownership.", nil)
		}
	}
	for _, metadata := range manifest.Metadata {
		task, exists := tasks[metadata.TaskID]
		if !exists || metadata.ProjectID != task.ProjectID {
			return m.failure("ownership", "Attachment metadata does not match its migration task owner.", nil)
		}
		entry, found := indexed[task.TaskID][metadata.Path]
		if !found || entry.Kind != "file" || entry.Size != metadata.SizeBytes {
			return &AttachmentMigrationError{OperationID: m.operation, Phase: m.phase, Category: "missing_content", Diagnostic: "Registered attachment content is missing or has a different size.", ProjectID: task.ProjectID, TaskID: task.TaskID}
		}
	}
	return nil
}

func attachmentMigrationHashValid(value string) bool {
	data, err := hex.DecodeString(value)
	return err == nil && len(data) == sha256.Size && strings.ToLower(value) == value
}

func (m *attachmentMigration) saveState(phase, hash string) error {
	_, err := m.writeJSON(m.directory()+"/state.json", attachmentMigrationState{Version: 1, OperationID: m.operation, ManifestSHA256: hash, Phase: phase}, true)
	if err == nil {
		m.phase = phase
	}
	return err
}

func (m *attachmentMigration) readJSON(name string, value any) (string, error) {
	info, err := m.root.Lstat(name)
	if err != nil {
		return "", m.failure("filesystem", "A migration operation record could not be inspected.", err)
	}
	if !info.Mode().IsRegular() {
		return "", m.failure("unsafe_entry", "A migration operation record is not a regular file.", nil)
	}
	file, err := m.root.Open(name)
	if err != nil {
		return "", m.failure("filesystem", "A migration operation record could not be opened.", err)
	}
	digest := sha256.New()
	decoder := json.NewDecoder(io.TeeReader(file, digest))
	decoder.DisallowUnknownFields()
	err = decoder.Decode(value)
	if err == nil {
		var trailing any
		if next := decoder.Decode(&trailing); next != io.EOF {
			if next == nil {
				err = errors.New("additional JSON value")
			} else {
				err = next
			}
		}
	}
	err = errors.Join(err, file.Close())
	if err != nil {
		return "", m.failure("invalid_manifest", "A migration operation record is invalid.", err)
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
