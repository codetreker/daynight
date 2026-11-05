package migration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"hash"
	"io"
	"log/slog"
	"os"
	"reflect"
	"slices"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

const attachmentMigrationPrefix = ".attachment-layout-"
const attachmentMigrationPendingPrefix = ".attachment-plan-"

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
	database  store.AttachmentMaintenance
	logger    *slog.Logger
	operation string
	phase     string
}

// ValidateRequest validates the action before opening any maintenance resources.
func ValidateRequest(action, operationID string) (string, error) {
	m := &attachmentMigration{phase: "configuration"}
	if action != "plan" && action != "apply" && action != "resume" {
		return "", m.failure("invalid_input", "Migration action must be plan, apply, or resume.", nil)
	}
	if action == "plan" {
		if operationID != "" {
			return "", m.failure("invalid_input", "A new migration plan cannot specify an operation ID.", nil)
		}
		return "", nil
	}
	id, err := model.CanonicalID(operationID)
	if err != nil {
		return "", m.failure("invalid_input", "A valid migration operation ID is required.", err)
	}
	return id, nil
}

// Run requires all HTTP, direct database, and file writers to remain stopped.
// The maintenance session lock serializes maintenance; it does not fence application writes.
func Run(ctx context.Context, database store.AttachmentMaintenance, root *os.Root, action, operationID string, logger *slog.Logger) (AttachmentMigrationSummary, error) {
	id, err := ValidateRequest(action, operationID)
	if err != nil {
		return AttachmentMigrationSummary{}, err
	}
	m := &attachmentMigration{database: database, root: root, logger: logger, operation: id, phase: "inventory"}
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
		canonical, err := model.CanonicalID(id)
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

type snapshotVisitor struct {
	m        *attachmentMigration
	result   attachmentMigrationSnapshot
	digest   hash.Hash
	projects map[string]bool
	owners   map[string]string
}

func (v *snapshotVisitor) Identity(identity store.AttachmentMaintenanceIdentity) error {
	data, err := json.Marshal([]any{identity.Host, identity.Port, identity.Database, identity.DatabaseOID, identity.Schema, identity.Relations})
	if err != nil {
		return v.m.failure("inventory", "Migration database identity could not be encoded.", err)
	}
	v.result.identity = attachmentMigrationIdentity{Database: identity.Database, Schema: identity.Schema, Relations: identity.Relations, Fingerprint: attachmentMigrationDigest(data)}
	return nil
}
func (v *snapshotVisitor) Project(project store.AttachmentMaintenanceProject) error {
	v.projects[project.ID] = true
	fmt.Fprintln(v.digest, "projects", project.Data)
	return nil
}
func (v *snapshotVisitor) Owner(owner store.AttachmentMaintenanceOwner) error {
	if !v.projects[owner.ProjectID] {
		return v.m.failure("ownership", "A migration task references a missing project.", nil)
	}
	v.owners[owner.TaskID] = owner.ProjectID
	v.result.owners = append(v.result.owners, attachmentMigrationOwner{ProjectID: owner.ProjectID, TaskID: owner.TaskID})
	fmt.Fprintln(v.digest, "tasks", owner.Data)
	return nil
}
func (v *snapshotVisitor) Metadata(metadata store.AttachmentMaintenanceMetadata) error {
	if v.owners[metadata.TaskID] != metadata.ProjectID {
		return v.m.failure("ownership", "Attachment metadata has no matching project and task owner.", nil)
	}
	if err := filestorage.ValidateAddress(attachmentcore.Bucket, metadata.Path); err != nil || metadata.SizeBytes < 0 {
		return v.m.failure("invalid_metadata", "Attachment metadata contains an invalid relative path or size.", err)
	}
	v.result.metadata = append(v.result.metadata, attachmentMigrationMetadata{ProjectID: metadata.ProjectID, TaskID: metadata.TaskID, Path: metadata.Path, SizeBytes: metadata.SizeBytes, Data: metadata.Data})
	fmt.Fprintln(v.digest, "task_attachments", metadata.Data)
	return nil
}
func (m *attachmentMigration) snapshot(ctx context.Context) (attachmentMigrationSnapshot, error) {
	visitor := &snapshotVisitor{m: m, result: attachmentMigrationSnapshot{owners: []attachmentMigrationOwner{}, metadata: []attachmentMigrationMetadata{}}, digest: sha256.New(), projects: map[string]bool{}, owners: map[string]string{}}
	if err := m.database.Snapshot(ctx, visitor); err != nil {
		var migrationError *AttachmentMigrationError
		if errors.As(err, &migrationError) {
			return visitor.result, err
		}
		return visitor.result, m.failure("database", maintenanceDiagnostic(err, "Migration metadata snapshot failed."), err)
	}
	visitor.result.digest = hex.EncodeToString(visitor.digest.Sum(nil))
	return visitor.result, nil
}

// MaintenanceDiagnostic maps neutral persistence failures to safe migration diagnostics.
func MaintenanceDiagnostic(err error) string {
	return maintenanceDiagnostic(err, "Migration database connection failed.")
}

func maintenanceDiagnostic(err error, fallback string) string {
	var failure *store.AttachmentMaintenanceError
	if !errors.As(err, &failure) {
		return fallback
	}
	switch failure.Stage {
	case store.AttachmentMaintenanceConfig:
		return "Migration database configuration is invalid."
	case store.AttachmentMaintenanceConnect:
		return "Migration database connection failed."
	case store.AttachmentMaintenanceLock:
		return "Migration ownership lock failed."
	case store.AttachmentMaintenanceSnapshotOpen:
		return "Migration metadata snapshot could not be opened."
	case store.AttachmentMaintenanceSnapshotTimezone:
		return "Migration snapshot time zone could not be set."
	case store.AttachmentMaintenanceIdentityRead:
		return "Migration database identity could not be read."
	case store.AttachmentMaintenanceRelationsRead:
		return "Migration source tables could not be identified."
	case store.AttachmentMaintenanceProjectsQuery:
		return "Migration projects could not be read."
	case store.AttachmentMaintenanceProjectsDecode:
		return "Migration project row could not be decoded."
	case store.AttachmentMaintenanceProjectsRead:
		return "Migration project inventory failed."
	case store.AttachmentMaintenanceTasksQuery:
		return "Migration tasks could not be read."
	case store.AttachmentMaintenanceTasksDecode:
		return "Migration task row could not be decoded."
	case store.AttachmentMaintenanceTasksRead:
		return "Migration task inventory failed."
	case store.AttachmentMaintenanceMetadataQuery:
		return "Migration attachment metadata could not be read."
	case store.AttachmentMaintenanceMetadataDecode:
		return "Migration attachment row could not be decoded."
	case store.AttachmentMaintenanceMetadataRead:
		return "Migration attachment inventory failed."
	case store.AttachmentMaintenanceSnapshotCommit:
		return "Migration metadata snapshot could not be closed."
	default:
		return "Migration metadata snapshot failed."
	}
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
	bucket, err := m.inspectDirectory(attachmentcore.Bucket)
	if err != nil {
		return AttachmentMigrationSummary{}, err
	}
	manifest.BucketExists = bucket
	directories := map[string]bool{}
	if bucket {
		entries, err := m.readDirectory(ctx, attachmentcore.Bucket)
		if err != nil {
			return AttachmentMigrationSummary{}, err
		}
		for _, entry := range entries {
			id, err := model.CanonicalID(entry.Name())
			if err != nil || id != entry.Name() || !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
				return AttachmentMigrationSummary{}, m.failure("unsafe_entry", "The legacy attachment bucket contains an invalid task directory.", err)
			}
			directories[id] = true
		}
	}
	for _, owner := range snapshot.owners {
		task := attachmentMigrationTask{ProjectID: owner.ProjectID, TaskID: owner.TaskID, Exists: directories[owner.TaskID], Entries: []attachmentMigrationEntry{}}
		if task.Exists {
			task.Entries, err = m.inventory(ctx, attachmentcore.Bucket+"/"+task.TaskID, true)
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
	if err := m.initializePlan(ctx, manifest); err != nil {
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
		project, projectErr := model.CanonicalID(task.ProjectID)
		id, taskErr := model.CanonicalID(task.TaskID)
		if projectErr != nil || taskErr != nil || project != task.ProjectID || id != task.TaskID {
			return m.failure("invalid_manifest", "The migration manifest contains an invalid task identity.", errors.Join(projectErr, taskErr))
		}
		if _, exists := tasks[task.TaskID]; exists {
			return m.failure("invalid_manifest", "The migration manifest contains duplicate task identities.", nil)
		}
		entries := map[string]attachmentMigrationEntry{}
		for _, entry := range task.Entries {
			if entry.Path != "." {
				if err := filestorage.ValidateAddress(attachmentcore.Bucket, entry.Path); err != nil {
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
