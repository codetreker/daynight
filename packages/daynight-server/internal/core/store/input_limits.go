package store

import (
	"context"
	"time"
)

// InputLimitsSnapshot keeps an offline inspection on one database connection.
// A read-only repeatable-read snapshot does not fence application or file writers.
type InputLimitsSnapshot interface {
	Scan(context.Context, InputLimitsVisitor) error
	Close(context.Context) error
}

// InputLimitsIdentity identifies the database, schema and snapshot that were read.
type InputLimitsIdentity struct {
	Host, Port, ServerAddress, ServerPort, SystemIdentifier, Database, DatabaseOID, Schema, Snapshot string
	Relations                                                                                        map[string]string
	ObservedAt                                                                                       time.Time
}

// InputLimitsField separates a SQL NULL from a value withheld by the budget.
// Bytes and Characters describe the original value, never a truncated prefix.
type InputLimitsField struct {
	Present           bool
	Bytes, Characters int64
	Value             *string
	SHA256            string
}

// InputLimitsRecord is a bounded projection of one resource or candidate.
// IDs contain only fixed-size identifiers. CandidateComplete is false when
// any necessary original value could not be read within the inspection budget.
type InputLimitsRecord struct {
	Kind                                          string
	IDs                                           map[string]string
	Fields                                        map[string]InputLimitsField
	Numbers                                       map[string]int64
	CandidateComplete                             bool
	Properties                                    map[string]string
	Dependencies, ExternalDependencies, BlockedBy []string
}

// InputLimitsVisitor must process each record before returning; it must not
// retain candidates across calls. An error aborts the snapshot unchanged.
// Identity is called exactly once before records. A successful Scan means all
// resource kinds were visited and the read-only transaction committed.
type InputLimitsVisitor interface {
	Identity(InputLimitsIdentity) error
	Record(InputLimitsRecord) error
}
