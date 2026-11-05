package store

import "context"

// AttachmentMaintenance retains one exclusively locked database session for an
// entire offline attachment operation. Snapshots must use that same session.
type AttachmentMaintenance interface {
	Snapshot(context.Context, AttachmentMaintenanceVisitor) error
	Close(context.Context) error
}

// AttachmentMaintenanceIdentity supplies the inputs to the persisted database
// fingerprint, including the configured host and port and resolved relations.
type AttachmentMaintenanceIdentity struct {
	Host, Port, Database, DatabaseOID, Schema string
	Relations                                 map[string]string
}

type AttachmentMaintenanceProject struct {
	ID, Data string
}

type AttachmentMaintenanceOwner struct {
	ProjectID, TaskID, Data string
}

type AttachmentMaintenanceMetadata struct {
	ProjectID, TaskID, Path string
	SizeBytes               int64
	Data                    string
}

// AttachmentMaintenanceVisitor consumes identity and ordered inventory rows
// within the snapshot transaction. A callback error stops the scan and rolls it
// back; the error is returned unchanged. JSON text is supplied one row at a time.
type AttachmentMaintenanceVisitor interface {
	Identity(AttachmentMaintenanceIdentity) error
	Project(AttachmentMaintenanceProject) error
	Owner(AttachmentMaintenanceOwner) error
	Metadata(AttachmentMaintenanceMetadata) error
}

// AttachmentMaintenanceStage identifies the database operation that failed.
type AttachmentMaintenanceStage string

const (
	AttachmentMaintenanceConfig           AttachmentMaintenanceStage = "config"
	AttachmentMaintenanceConnect          AttachmentMaintenanceStage = "connect"
	AttachmentMaintenanceLock             AttachmentMaintenanceStage = "lock"
	AttachmentMaintenanceSnapshotOpen     AttachmentMaintenanceStage = "snapshot_open"
	AttachmentMaintenanceSnapshotTimezone AttachmentMaintenanceStage = "snapshot_timezone"
	AttachmentMaintenanceIdentityRead     AttachmentMaintenanceStage = "identity_read"
	AttachmentMaintenanceRelationsRead    AttachmentMaintenanceStage = "relations_read"
	AttachmentMaintenanceProjectsQuery    AttachmentMaintenanceStage = "projects_query"
	AttachmentMaintenanceProjectsDecode   AttachmentMaintenanceStage = "projects_decode"
	AttachmentMaintenanceProjectsRead     AttachmentMaintenanceStage = "projects_read"
	AttachmentMaintenanceTasksQuery       AttachmentMaintenanceStage = "tasks_query"
	AttachmentMaintenanceTasksDecode      AttachmentMaintenanceStage = "tasks_decode"
	AttachmentMaintenanceTasksRead        AttachmentMaintenanceStage = "tasks_read"
	AttachmentMaintenanceMetadataQuery    AttachmentMaintenanceStage = "metadata_query"
	AttachmentMaintenanceMetadataDecode   AttachmentMaintenanceStage = "metadata_decode"
	AttachmentMaintenanceMetadataRead     AttachmentMaintenanceStage = "metadata_read"
	AttachmentMaintenanceSnapshotCommit   AttachmentMaintenanceStage = "snapshot_commit"
)

// AttachmentMaintenanceError identifies a database failure and retains its cause.
type AttachmentMaintenanceError struct {
	Stage AttachmentMaintenanceStage
	Cause error
}

func (e *AttachmentMaintenanceError) Error() string {
	return "attachment maintenance: " + string(e.Stage)
}
func (e *AttachmentMaintenanceError) Unwrap() error { return e.Cause }
