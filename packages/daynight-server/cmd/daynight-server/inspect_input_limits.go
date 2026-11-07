package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/inputpolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/maintenance"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/inputlimitinspect"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/inputlimitreport"
)

// Tests compare this digest to the checked-in specification.
const inputSpecSHA = "8ad8c7087e60c8a8b10eb31ffbdd1e5adca6288ce283e8179579000d254338f9"

func policyDigest(version string, entries []inputpolicy.Entry) string {
	// This fixed structure contains only strings, integers, booleans and slices.
	data, _ := json.Marshal(struct {
		Version string              `json:"version"`
		Entries []inputpolicy.Entry `json:"entries"`
	}{version, entries})
	return fmt.Sprintf("%x", sha256.Sum256(data))
}

func inputPolicySHA() string { return policyDigest(inputpolicy.Version, inputpolicy.Catalog()) }

type inspectionSource struct {
	SHA      string
	Modified bool
}

func currentInspectionSource() inspectionSource {
	info, ok := debug.ReadBuildInfo()
	return inspectionSourceFromBuildInfo(info, ok)
}

func inspectionSourceFromBuildInfo(info *debug.BuildInfo, ok bool) inspectionSource {
	result := inspectionSource{Modified: true}
	if ok && info != nil {
		for _, setting := range info.Settings {
			switch setting.Key {
			case "vcs.revision":
				result.SHA = setting.Value
			case "vcs.modified":
				result.Modified = setting.Value != "false"
			}
		}
	}
	return result
}

func runInputLimitsInspection(ctx context.Context, args []string, getenv func(string) string, stdout io.Writer, logger *slog.Logger) int {
	if strings.TrimSpace(getenv("DAYNIGHT_DATABASE_URL")) == "" || strings.TrimSpace(getenv("DAYNIGHT_STORAGE_ROOT")) == "" {
		logger.ErrorContext(ctx, "input limits inspection failed", "phase", "configuration", "diagnostic", "Set DAYNIGHT_DATABASE_URL and DAYNIGHT_STORAGE_ROOT.")
		return 1
	}
	var err error
	switch {
	case len(args) == 1:
		err = inspectInputLimits(ctx, getenv("DAYNIGHT_DATABASE_URL"), getenv("DAYNIGHT_STORAGE_ROOT"), stdout, currentInspectionSource())
	case len(args) == 5 && args[1] == "--verify-report" && args[3] == "--writers-stopped-since":
		var start time.Time
		start, err = time.Parse(time.RFC3339Nano, args[4])
		if err == nil {
			err = verifyInputLimits(ctx, getenv("DAYNIGHT_DATABASE_URL"), getenv("DAYNIGHT_STORAGE_ROOT"), args[2], start, currentInspectionSource())
		}
	default:
		err = errors.New("invalid inspection arguments")
	}
	if err != nil {
		// Errors can contain SQL values or paths. Keep the chain for callers while
		// the CLI emits only a bounded diagnostic without stored data.
		logger.ErrorContext(ctx, "input limits inspection failed", "phase", "inspection", "diagnostic", "Inspection did not produce a clear result.")
		return 1
	}
	return 0
}

var inspectionKinds = []string{"task", "property", "step", "project", "team", "profile", "worker", "workerConfig", "attachment", "archive", "transfer", "transferChunk", "orphanProperty", "orphanDependency", "orphanAttachment", "login", "activeOwner"}

func openInspectionRoot(path string) (*os.Root, string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, "", err
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return nil, "", err
	}
	root, err := os.OpenRoot(resolved)
	if err != nil {
		return nil, "", err
	}
	info, err := root.Stat(".")
	if err != nil {
		return nil, "", errors.Join(err, root.Close())
	}
	identity, err := storageRootFingerprint(resolved, info)
	if err != nil {
		return nil, "", errors.Join(err, root.Close())
	}
	return root, identity, nil
}

func storageIdentity(path string) (string, error) {
	root, identity, err := openInspectionRoot(path)
	if err != nil {
		return "", err
	}
	return identity, root.Close()
}

func inspectInputLimits(ctx context.Context, databaseURL, storageRoot string, output io.Writer, source inspectionSource) error {
	w := inputlimitreport.New(output)
	root, storageSHA, err := openInspectionRoot(storageRoot)
	if err != nil {
		return fmt.Errorf("resolve storage root: %w", err)
	}
	snapshot, err := maintenance.OpenInputLimits(ctx, databaseURL)
	if err != nil {
		return errors.Join(fmt.Errorf("open inspection: %w", err), root.Close())
	}
	write := func(value any) error {
		b, err := json.Marshal(value)
		if err != nil {
			return err
		}
		return w.WriteRecord(b)
	}
	inspect := inputlimitinspect.New(ctx, func(ctx context.Context, bucket, path string) (int64, error) {
		return inspectionStat(ctx, root, bucket, path)
	}, func(identity store.InputLimitsIdentity) error {
		return write(struct {
			Type           string                    `json:"type"`
			SourceSHA      string                    `json:"sourceSha"`
			SourceModified bool                      `json:"sourceModified"`
			PolicySHA      string                    `json:"policySha"`
			SpecSHA        string                    `json:"specSha"`
			PolicyVersion  string                    `json:"policyVersion"`
			StorageRootSHA string                    `json:"storageRootSha"`
			Identity       store.InputLimitsIdentity `json:"identity"`
		}{"header", source.SHA, source.Modified, inputPolicySHA(), inputSpecSHA, inputpolicy.Version, storageSHA, identity})
	}, func(finding inputlimitinspect.Finding) error {
		return write(struct {
			Type string `json:"type"`
			inputlimitinspect.Finding
		}{"finding", finding})
	})
	scanErr := snapshot.Scan(ctx, inspect)
	if scanErr == nil {
		scanErr = inspect.Finish()
	}
	closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	closeErr := errors.Join(snapshot.Close(closeCtx), root.Close())
	cancel()
	outcome := inspect.Outcome()
	if err := ctx.Err(); err != nil {
		scanErr = errors.Join(scanErr, err)
	}
	complete := scanErr == nil && closeErr == nil && !outcome.Incomplete && source.SHA != "" && !source.Modified
	clear := complete && outcome.Findings == 0 && outcome.Indeterminate == 0
	reason := ""
	switch {
	case errors.Is(scanErr, inputlimitreport.ErrReportBudget), errors.Is(scanErr, inputlimitreport.ErrRecordBudget):
		reason = "budget_exceeded"
	case scanErr != nil || closeErr != nil:
		reason = "inspection_error"
	case source.SHA == "" || source.Modified:
		reason = "unverified_source"
	case outcome.Incomplete:
		reason = "incomplete"
	}
	counts := outcome.Counts
	for _, kind := range inspectionKinds {
		if _, ok := counts[kind]; !ok {
			counts[kind] = 0
		}
	}
	summary, marshalErr := json.Marshal(struct {
		Type          string           `json:"type"`
		Complete      bool             `json:"complete"`
		Clear         bool             `json:"clear"`
		Counts        map[string]int64 `json:"counts"`
		Findings      int64            `json:"findings"`
		Indeterminate int64            `json:"indeterminate"`
		Reason        string           `json:"reason,omitempty"`
	}{"summary", complete, clear, counts, outcome.Findings, outcome.Indeterminate, reason})
	var summaryErr error
	if marshalErr == nil {
		summaryErr = w.Finish(summary)
	}
	if !clear {
		return errors.Join(errors.New("input limits inspection is not clear"), scanErr, closeErr, marshalErr, summaryErr)
	}
	return errors.Join(scanErr, closeErr, marshalErr, summaryErr)
}

var errIdentityObserved = errors.New("inspection identity observed")

type identityVisitor struct{ identity store.InputLimitsIdentity }

func (v *identityVisitor) Identity(identity store.InputLimitsIdentity) error {
	v.identity = identity
	return errIdentityObserved
}
func (*identityVisitor) Record(store.InputLimitsRecord) error {
	return errors.New("unexpected inspection record")
}

func verifyInputLimits(ctx context.Context, databaseURL, storageRoot, reportPath string, start time.Time, source inspectionSource) error {
	if source.Modified || source.SHA == "" {
		return errors.New("unverified source")
	}
	storageSHA, err := storageIdentity(storageRoot)
	if err != nil {
		return fmt.Errorf("storage identity: %w", err)
	}
	snapshot, err := maintenance.OpenInputLimits(ctx, databaseURL)
	if err != nil {
		return err
	}
	v := &identityVisitor{}
	err = snapshot.Scan(ctx, v)
	closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	closeErr := snapshot.Close(closeCtx)
	cancel()
	if err != errIdentityObserved {
		return errors.Join(err, closeErr, errors.New("database identity unavailable"))
	}
	if closeErr != nil {
		return closeErr
	}
	file, err := openInspectionReport(reportPath)
	if err != nil {
		return err
	}
	id := v.identity
	err = inputlimitreport.VerifyClear(contextReader{ctx: ctx, reader: file}, inputlimitreport.GateContext{
		SourceSHA: source.SHA, PolicySHA: inputPolicySHA(), SpecSHA: inputSpecSHA, PolicyVersion: inputpolicy.Version, StorageRootSHA: storageSHA,
		Database:    inputlimitreport.DatabaseIdentity{Host: id.Host, Port: id.Port, ServerAddress: id.ServerAddress, ServerPort: id.ServerPort, SystemIdentifier: id.SystemIdentifier, Database: id.Database, DatabaseOID: id.DatabaseOID, Schema: id.Schema, Relations: id.Relations},
		WindowStart: start, Now: time.Now(), RequiredKinds: inspectionKinds,
	})
	return errors.Join(err, ctx.Err(), file.Close())
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.reader.Read(p)
	if canceled := r.ctx.Err(); canceled != nil {
		return n, canceled
	}
	return n, err
}

// inspectionStat rejects symlinks in every component and never opens file data.
// The operator must stop file writers for the duration of the snapshot.
func inspectionStat(ctx context.Context, root *os.Root, bucket, path string) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if err := filestorage.ValidateAddress(bucket, path); err != nil {
		return 0, err
	}
	parts := strings.Split(bucket+"/"+path, "/")
	for n := range parts {
		info, err := root.Lstat(filepath.Join(parts[:n+1]...))
		if err != nil {
			return 0, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return 0, filestorage.ErrInvalidAddress
		}
		if n < len(parts)-1 && !info.IsDir() {
			return 0, filestorage.ErrInvalidAddress
		}
		if n == len(parts)-1 {
			if !info.Mode().IsRegular() {
				return 0, filestorage.ErrNotRegular
			}
			return info.Size(), nil
		}
	}
	return 0, filestorage.ErrInvalidAddress
}
