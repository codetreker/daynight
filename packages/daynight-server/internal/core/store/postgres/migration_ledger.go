package postgres

import (
	"context"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const schemaBaselineVersion int64 = 99

// The original runner produced these checksums, including the frozen Go transformations.
// https://github.com/codetreker/daynight/blob/2060f6d2059055f2abcc2086ceebed81752a7982/packages/daynight-server/internal/core/store/postgres/migrate.go
//
//go:embed schema/legacy-checksums.tsv
var legacyChecksumManifest string

type migrationChecksum struct {
	version  int64
	checksum string
}

var legacyMigrationChecksums = parseLegacyChecksumManifest(legacyChecksumManifest)

func parseLegacyChecksumManifest(manifest string) []migrationChecksum {
	var entries []migrationChecksum
	var previous int64
	for _, line := range strings.Split(strings.TrimSuffix(manifest, "\n"), "\n") {
		versionText, digest, found := strings.Cut(strings.TrimSuffix(line, "\r"), "\t")
		version, versionErr := strconv.ParseInt(versionText, 10, 64)
		_, digestErr := hex.DecodeString(digest)
		if !found || versionErr != nil || version <= previous || digestErr != nil || len(digest) != 64 {
			panic(fmt.Sprintf("invalid legacy migration checksum entry %q", line))
		}
		entries = append(entries, migrationChecksum{version: version, checksum: digest})
		previous = version
	}
	if previous != schemaBaselineVersion {
		panic(fmt.Sprintf("legacy migration checksums end at version %d; expected %d", previous, schemaBaselineVersion))
	}
	return entries
}

func migrationChecksums(migrations []migration) []migrationChecksum {
	entries := make([]migrationChecksum, len(legacyMigrationChecksums)+len(migrations))
	copy(entries, legacyMigrationChecksums)
	for index, migration := range migrations {
		entries[len(legacyMigrationChecksums)+index] = migrationChecksum{
			version:  migration.version,
			checksum: migration.checksum(),
		}
	}
	return entries
}

type baselineUpgradeRequiredError struct {
	version int64
}

func (e *baselineUpgradeRequiredError) Error() string {
	if e.version == 0 {
		return fmt.Sprintf("migration ledger is missing or empty; verify the database's history before using the version-%d migration bridge", schemaBaselineVersion)
	}
	return fmt.Sprintf("migration version %d precedes the supported baseline %d; upgrade with the version-%d migration bridge first", e.version, schemaBaselineVersion, schemaBaselineVersion)
}

type migrationLedgerMismatchError struct {
	version          int64
	checksumMismatch bool
}

func (e *migrationLedgerMismatchError) Error() string {
	if e.checksumMismatch {
		return fmt.Sprintf("migration version %d checksum mismatch", e.version)
	}
	return fmt.Sprintf("migration version %d is not an ordered prefix", e.version)
}

func migrationFailure(phase string, err error) error {
	var upgrade *baselineUpgradeRequiredError
	var mismatch *migrationLedgerMismatchError
	switch {
	case errors.As(err, &upgrade):
		phase += " (" + upgrade.Error() + ")"
	case errors.As(err, &mismatch):
		phase += " (" + mismatch.Error() + ")"
	}
	return databaseFailure(phase, err)
}

type migrationLedger struct {
	relation string
	applied  int
}

// readMigrationLedger validates the full ordered ledger and counts the applied
// executable migrations after the baseline.
func readMigrationLedger(ctx context.Context, conn *pgxpool.Conn, migrations []migration) (migrationLedger, error) {
	var namespace string
	var ledgerExists bool
	if err := conn.QueryRow(ctx, `SELECT current_schema(), to_regclass(quote_ident(current_schema()) || '.schema_migrations') IS NOT NULL`).Scan(&namespace, &ledgerExists); err != nil {
		return migrationLedger{}, err
	}
	if !ledgerExists {
		return migrationLedger{}, &baselineUpgradeRequiredError{}
	}
	relation := pgx.Identifier{namespace, "schema_migrations"}.Sanitize()
	rows, err := conn.Query(ctx, `SELECT version, checksum FROM `+relation+` ORDER BY version`)
	if err != nil {
		return migrationLedger{}, err
	}
	defer rows.Close()

	entries := migrationChecksums(migrations)
	applied := 0
	var lastVersion int64
	for rows.Next() {
		var version int64
		var savedChecksum string
		if err := rows.Scan(&version, &savedChecksum); err != nil {
			return migrationLedger{}, err
		}
		if applied >= len(entries) || version != entries[applied].version {
			return migrationLedger{}, &migrationLedgerMismatchError{version: version}
		}
		if savedChecksum != entries[applied].checksum {
			return migrationLedger{}, &migrationLedgerMismatchError{version: version, checksumMismatch: true}
		}
		applied++
		lastVersion = version
	}
	if err := rows.Err(); err != nil {
		return migrationLedger{}, err
	}
	if applied < len(legacyMigrationChecksums) {
		return migrationLedger{}, &baselineUpgradeRequiredError{version: lastVersion}
	}
	return migrationLedger{relation: relation, applied: applied - len(legacyMigrationChecksums)}, nil
}
