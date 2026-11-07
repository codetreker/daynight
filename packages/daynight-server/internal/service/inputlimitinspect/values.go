package inputlimitinspect

import (
	"encoding/json"
	"io"
	pathpkg "path"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	sessionprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/profile"
	workerwire "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

const normalizedBudget = 32 << 20

// normalizationBound bounds JSON's HTML escaping after structural normalization.
// Whitespace outside strings disappears; escaped input already pays for its escape.
func normalizationBound(raw string) int64 {
	var n int64 = 4096
	in, escape := false, false
	for p := 0; p < len(raw); p++ {
		c := raw[p]
		if !in && (c == ' ' || c == '\n' || c == '\r' || c == '\t') {
			continue
		}
		n++
		if !in {
			if c == '"' {
				in = true
			}
			continue
		}
		if escape {
			escape = false
			continue
		}
		if c == '\\' {
			escape = true
			continue
		}
		if c == '"' {
			in = false
			continue
		}
		if c == '<' || c == '>' || c == '&' {
			n += 5
		}
		if c == 0xe2 && p+2 < len(raw) && raw[p+1] == 0x80 && (raw[p+2] == 0xa8 || raw[p+2] == 0xa9) {
			n += 3
		}
	}
	return n
}

func field(r store.InputLimitsRecord, key string) (string, bool) {
	v, ok := r.Fields[key]
	if !ok || !v.Present || v.Value == nil {
		return "", false
	}
	return *v.Value, true
}
func optional(r store.InputLimitsRecord, key string) (*string, bool) {
	v, ok := r.Fields[key]
	if !ok {
		return nil, false
	}
	if !v.Present {
		return nil, true
	}
	return v.Value, v.Value != nil
}
func parseTime(value string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999Z07:00", "2006-01-02 15:04:05.999999999Z07"} {
		if t, err := time.Parse(layout, value); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, strconv.ErrSyntax
}
func (i *Inspector) project(r store.InputLimitsRecord) error {
	for _, x := range []struct {
		field string
		max   int64
		chars bool
	}{{"name", project.MaxNameCodePoints, true}, {"name", project.MaxNameBytes, false}, {"repoUrl", project.MaxRepoURLBytes, false}} {
		if err := i.textLimit(r, x.field, x.max, x.chars); err != nil {
			return err
		}
	}
	return nil
}
func (i *Inspector) team(r store.InputLimitsRecord) error {
	for _, x := range []struct {
		max   int64
		chars bool
	}{{team.MaxNameCodePoints, true}, {team.MaxNameBytes, false}} {
		if err := i.textLimit(r, "name", x.max, x.chars); err != nil {
			return err
		}
	}
	return nil
}
func (i *Inspector) profile(r store.InputLimitsRecord) error {
	for _, x := range []struct {
		name string
		max  int64
	}{{"identityId", identity.MaxProfileFieldBytes}, {"email", identity.MaxProfileFieldBytes}, {"name", identity.MaxProfileFieldBytes}, {"avatarUrl", identity.MaxAvatarURLBytes}} {
		if err := i.textLimit(r, x.name, x.max, false); err != nil {
			return err
		}
	}
	id, ok := field(r, "identityId")
	if !ok {
		return i.incomplete(r, "identityId", "candidate unavailable")
	}
	email, e := optional(r, "email")
	name, n := optional(r, "name")
	avatar, a := optional(r, "avatarUrl")
	verified, v := optional(r, "emailVerified")
	if !e || !n || !a || !v {
		return i.incomplete(r, "profile", "candidate unavailable")
	}
	var verifiedValue *bool
	if verified != nil {
		b, err := strconv.ParseBool(*verified)
		if err != nil {
			return i.incomplete(r, "emailVerified", "invalid stored representation")
		}
		verifiedValue = &b
	}
	teamID, teamOK := field(r, "personalTeamId")
	teamName, nameOK := optional(r, "personalTeamName")
	if !teamOK || !nameOK {
		return i.incomplete(r, "personalTeam", "personal team unavailable")
	}
	user := model.User{ID: r.IDs["id"], UniAuthID: id, Email: email, Name: name, AvatarURL: avatar, EmailVerified: verifiedValue, PersonalTeam: model.TeamRef{ID: teamID, Kind: "personal", Name: teamName}}
	_, err := profile.Encode(io.Discard, profile.FromUser(user), identity.MaxProfileJSONBytes)
	if err = i.violation(r, err); err != nil {
		return err
	}
	_, err = profile.EncodeResponse(io.Discard, user, identity.MaxIdentityResponseBytes)
	return i.violation(r, err)
}
func (i *Inspector) property(r store.InputLimitsRecord) error {
	if f, ok := r.Fields["name"]; ok {
		r.IDs = copyIDs(r.IDs)
		r.IDs["propertyNameSha256"] = f.SHA256
	}
	name, n := field(r, "name")
	raw, v := field(r, "value")
	if !n || !v {
		return i.incomplete(r, "property", "candidate exceeds inspection budget or is missing")
	}
	if normalizationBound(raw) > normalizedBudget {
		return i.incomplete(r, "property", "normalization budget cannot be established")
	}
	normalized, err := taskproperty.NormalizeValue(name, json.RawMessage(raw))
	if err != nil {
		return i.violation(r, err)
	}
	if len(normalized) > normalizedBudget {
		return i.incomplete(r, "property", "normalization budget exceeded")
	}
	return i.violation(r, taskproperty.AdmitValue(name, normalized))
}
func (i *Inspector) worker(r store.InputLimitsRecord) error {
	telemetry, ok := field(r, "telemetry")
	tasks, tok := field(r, "taskSnapshot")
	created, cok := field(r, "createdAt")
	seen, sok := field(r, "lastSeenAt")
	if !ok || !tok || !cok || !sok {
		return i.incomplete(r, "worker", "candidate exceeds inspection budget or is missing")
	}
	var w model.WorkerSnapshot
	if json.Unmarshal([]byte(telemetry), &w.Telemetry) != nil || json.Unmarshal([]byte(tasks), &w.TaskSnapshot) != nil {
		return i.incomplete(r, "worker", "invalid stored representation")
	}
	var err error
	w.CreatedAt, err = parseTime(created)
	if err != nil {
		return i.incomplete(r, "createdAt", "invalid stored timestamp")
	}
	w.LastReportedAt, err = parseTime(seen)
	if err != nil {
		return i.incomplete(r, "lastSeenAt", "invalid stored timestamp")
	}
	w.UserID, w.WorkerID = r.IDs["userId"], r.IDs["workerId"]
	report, validationErr := worker.ValidateReport(model.WorkerReport{Telemetry: w.Telemetry})
	if validationErr != nil {
		return i.incomplete(r, "telemetry", "invalid stored representation")
	}
	w.Telemetry = report.Telemetry
	switch w.TaskSnapshot.State {
	case model.WorkerTasksUnavailable:
		if w.TaskSnapshot.ObservedAt != nil || len(w.TaskSnapshot.Items) != 0 {
			return i.incomplete(r, "taskSnapshot", "invalid stored observation")
		}
	case model.WorkerTasksObserved, model.WorkerTasksStale:
		if w.TaskSnapshot.ObservedAt == nil || w.TaskSnapshot.InventoryObservedAt == nil || w.TaskSnapshot.Items == nil {
			return i.incomplete(r, "taskSnapshot", "invalid stored observation")
		}
	default:
		return i.incomplete(r, "taskSnapshot", "invalid stored observation")
	}
	if err = i.violation(r, worker.AdmitTelemetry(w.Telemetry)); err != nil {
		return err
	}
	claims := len(w.TaskSnapshot.Items)
	if claims > worker.MaxInventoryClaims {
		claims = worker.MaxInventoryClaims + 1
	}
	inventory := model.WorkerTaskInventory{Claims: make([]model.WorkerTaskReference, claims)}
	if err = i.violation(r, worker.AdmitInventory(inventory)); err != nil {
		return err
	}
	_, err = workerwire.EncodeTelemetry(io.Discard, w.Telemetry, worker.MaxTelemetryJSONBytes)
	if err = i.violation(r, err); err != nil {
		return err
	}
	_, err = workerwire.EncodeItem(io.Discard, w, worker.MaxWorkerJSONBytes)
	return i.violation(r, err)
}
func (i *Inspector) workerConfig(r store.InputLimitsRecord) error {
	desired, d := optional(r, "desired")
	observation, o := optional(r, "observation")
	if !d || !o {
		return i.incomplete(r, "configuration", "candidate exceeds inspection budget or is missing")
	}
	if desired != nil {
		if normalizationBound(*desired) > normalizedBudget {
			return i.incomplete(r, "desired", "normalization budget cannot be established")
		}
		value, err := worker.ParseWorkerConfiguration(json.RawMessage(*desired))
		if err != nil {
			return i.violation(r, err)
		}
		if err = i.violation(r, worker.AdmitConfiguration(value)); err != nil {
			return err
		}
		_, err = workerwire.EncodeConfiguration(io.Discard, value, worker.MaxConfigurationJSONBytes)
		if err = i.violation(r, err); err != nil {
			return err
		}
	}
	if observation != nil {
		var value model.WorkerConfigurationReportedObservation
		if json.Unmarshal([]byte(*observation), &value) != nil {
			return i.incomplete(r, "observation", "invalid stored representation")
		}
		if err := i.violation(r, worker.AdmitObservation(value.WorkerConfigurationObservation)); err != nil {
			return err
		}
		_, err := workerwire.EncodeObservation(io.Discard, value, worker.MaxConfigurationJSONBytes)
		if err = i.violation(r, err); err != nil {
			return err
		}
	}
	return nil
}
func (i *Inspector) attachment(r store.InputLimitsRecord) error {
	if f, exists := r.Fields["path"]; exists {
		r.IDs = copyIDs(r.IDs)
		r.IDs["pathSha256"] = f.SHA256
	}
	for _, x := range []struct {
		name  string
		max   int64
		chars bool
	}{{"path", attachment.MaxPathCharacters, true}, {"contentType", attachment.MaxContentTypeBytes, false}} {
		if err := i.textLimit(r, x.name, x.max, x.chars); err != nil {
			return err
		}
	}
	path, ok := field(r, "path")
	size, sk := field(r, "sizeBytes")
	if !ok || !sk {
		return i.incomplete(r, "path", "file location unavailable")
	}
	expected, err := strconv.ParseInt(size, 10, 64)
	if err != nil {
		return i.incomplete(r, "sizeBytes", "invalid stored size")
	}
	if err = i.violation(r, attachment.AdmitContentSize(expected)); err != nil {
		return err
	}
	address, err := attachment.NewAddress(r.IDs["projectId"], r.IDs["taskId"], path)
	if err != nil {
		return i.incomplete(r, "path", "invalid file location")
	}
	if i.stat == nil {
		return i.incomplete(r, "file", "stat unavailable")
	}
	actual, err := i.stat(i.ctx, attachment.Bucket, address.StoragePath)
	if err != nil {
		i.outcome.Incomplete = true
		return err
	}
	if err = i.violation(r, attachment.AdmitContentSize(actual)); err != nil {
		return err
	}
	if actual != expected {
		return i.finding(r, "sizeBytes", "violation", "metadata differs from file size", actual, expected, "bytes", false)
	}
	return nil
}
func copyIDs(ids map[string]string) map[string]string {
	c := make(map[string]string, len(ids)+1)
	for k, v := range ids {
		c[k] = v
	}
	return c
}
func (i *Inspector) archive(r store.InputLimitsRecord) error {
	state, ok := field(r, "state")
	if !ok {
		return i.incomplete(r, "state", "missing archive state")
	}
	if state != "ready" {
		return nil
	}
	path, p := field(r, "objectPath")
	size, s := field(r, "byteLength")
	if f, exists := r.Fields["objectPath"]; exists {
		r.IDs = copyIDs(r.IDs)
		r.IDs["pathSha256"] = f.SHA256
	}
	if !p || !s {
		return i.incomplete(r, "objectPath", "archive location unavailable")
	}
	expected, err := strconv.ParseInt(size, 10, 64)
	if err != nil {
		return i.incomplete(r, "byteLength", "invalid stored size")
	}
	scope, scopeOK := field(r, "scope")
	owner, ownerOK := field(r, "ownerUserId")
	project, projectOK := optional(r, "projectId")
	if !scopeOK || !ownerOK || !projectOK {
		return i.incomplete(r, "objectPath", "archive owner unavailable")
	}
	kind := sessionarchive.Users
	namespaceOwner := owner
	if project != nil {
		kind = sessionarchive.Projects
		namespaceOwner = *project
	}
	ns, err := sessionarchive.NewNamespace(kind, namespaceOwner, r.IDs["sessionId"])
	if err != nil {
		return i.incomplete(r, "objectPath", "invalid archive namespace")
	}
	if (scope == "task" && project == nil) || (scope == "test" && project != nil) || (scope != "task" && scope != "test") {
		return i.incomplete(r, "objectPath", "archive ownership scope is inconsistent")
	}
	digest := strings.TrimSuffix(pathpkg.Base(path), ".json")
	expectedPath, err := ns.ObjectPath(digest)
	if err != nil || path != expectedPath {
		return i.incomplete(r, "objectPath", "archive outside owner namespace")
	}
	if expected > sessionprotocol.MaxArchiveBytes {
		if err = i.finding(r, "byteLength", "violation", "", expected, sessionprotocol.MaxArchiveBytes, "bytes", false); err != nil {
			return err
		}
	}
	if i.stat == nil {
		return i.incomplete(r, "file", "stat unavailable")
	}
	actual, err := i.stat(i.ctx, sessionarchive.Bucket, path)
	if err != nil {
		i.outcome.Incomplete = true
		return err
	}
	if actual > sessionprotocol.MaxArchiveBytes {
		if err = i.finding(r, "fileSize", "violation", "", actual, sessionprotocol.MaxArchiveBytes, "bytes", false); err != nil {
			return err
		}
	}
	if actual != expected {
		return i.finding(r, "byteLength", "violation", "metadata differs from file size", actual, expected, "bytes", false)
	}
	return nil
}
func (i *Inspector) login(r store.InputLimitsRecord) error {
	if err := i.textLimit(r, "returnPath", identity.MaxReturnPathBytes, false); err != nil {
		return err
	}
	expires, ok := field(r, "expiresAt")
	if !ok || i.observed.IsZero() {
		return i.incomplete(r, "expiresAt", "login expiry or observation time unavailable")
	}
	expiry, err := parseTime(expires)
	if err != nil {
		return i.incomplete(r, "expiresAt", "invalid stored timestamp")
	}
	if expiry.After(i.observed) {
		return i.finding(r, "pendingLogin", "violation", "consume or allow to expire before activation", 1, 0, "items", false)
	}
	return nil
}
func (i *Inspector) activeOwner(r store.InputLimitsRecord) error {
	count, ok := r.Numbers["count"]
	if !ok {
		return i.incomplete(r, "count", "missing active count")
	}
	if count > worker.MaxActiveWorkers {
		return i.finding(r, "activeWorkers", "violation", "", count, worker.MaxActiveWorkers, "items", false)
	}
	return nil
}

func (i *Inspector) transfer(r store.InputLimitsRecord) error {
	if f, ok := r.Fields["path"]; ok {
		r.IDs = copyIDs(r.IDs)
		r.IDs["pathSha256"] = f.SHA256
	}
	state, ok := field(r, "state")
	if !ok {
		return i.incomplete(r, "state", "transfer state unavailable")
	}
	if state == "closed" {
		return nil
	}
	direction, ok := field(r, "direction")
	if !ok {
		return i.incomplete(r, "direction", "transfer direction unavailable")
	}
	if direction == "upload" && state == "receiving" {
		raw, ok := field(r, "data")
		if !ok {
			return i.incomplete(r, "data", "upload offset unavailable")
		}
		var data struct {
			NextOffset *int64 `json:"nextOffset"`
		}
		if json.Unmarshal([]byte(raw), &data) != nil || data.NextOffset == nil {
			return i.incomplete(r, "data", "invalid upload state")
		}
		if err := i.violation(r, attachment.AdmitContentSize(*data.NextOffset)); err != nil {
			return err
		}
		outstanding, ok := field(r, "outstandingBytes")
		if !ok {
			return i.incomplete(r, "outstandingBytes", "reservation unavailable")
		}
		reserved, err := strconv.ParseInt(outstanding, 10, 64)
		if err != nil || reserved < 0 {
			return i.incomplete(r, "outstandingBytes", "invalid reservation")
		}
		if reserved > 0 {
			return i.incomplete(r, "outstandingBytes", "unconfirmed transfer reservation")
		}
		chunks, ok := field(r, "chunkBytes")
		if !ok {
			return i.incomplete(r, "chunkBytes", "chunk total unavailable")
		}
		total, err := strconv.ParseInt(chunks, 10, 64)
		if err != nil || total != *data.NextOffset {
			return i.incomplete(r, "chunkBytes", "chunk total differs from upload offset")
		}
		return nil
	}
	if direction == "download" && state == "ready" {
		raw, ok := field(r, "data")
		if !ok {
			return i.incomplete(r, "data", "transfer snapshot unavailable")
		}
		var snapshot struct {
			ObjectID   string `json:"objectId"`
			TotalBytes *int64 `json:"totalBytes"`
		}
		if json.Unmarshal([]byte(raw), &snapshot) != nil || snapshot.TotalBytes == nil {
			return i.incomplete(r, "data", "invalid transfer snapshot")
		}
		return i.transferStat(r, snapshot.ObjectID, *snapshot.TotalBytes)
	}
	return i.incomplete(r, "state", "transfer requires lifecycle reconciliation")
}
func (i *Inspector) transferChunk(r store.InputLimitsRecord) error {
	state, ok := field(r, "state")
	if !ok {
		return i.incomplete(r, "state", "transfer state unavailable")
	}
	if state == "closed" {
		return nil
	}
	if state != "receiving" {
		return i.incomplete(r, "state", "transfer requires lifecycle reconciliation")
	}
	size, ok := field(r, "sizeBytes")
	if !ok {
		return i.incomplete(r, "sizeBytes", "chunk size unavailable")
	}
	expected, err := strconv.ParseInt(size, 10, 64)
	if err != nil {
		return i.incomplete(r, "sizeBytes", "invalid chunk size")
	}
	offsetRaw, ok := field(r, "offset")
	if !ok {
		return i.incomplete(r, "offset", "chunk offset unavailable")
	}
	offset, err := strconv.ParseInt(offsetRaw, 10, 64)
	if err != nil || offset < 0 {
		return i.incomplete(r, "offset", "invalid chunk offset")
	}
	if expected < 0 {
		return i.incomplete(r, "sizeBytes", "invalid chunk size")
	}
	if offset > attachment.MaxContentBytes || expected > attachment.MaxContentBytes-offset {
		actual := int64(attachment.MaxContentBytes + 1)
		lower := true
		if offset <= int64(^uint64(0)>>1)-expected {
			actual = offset + expected
			lower = false
		}
		if err = i.finding(r, "chunkEnd", "violation", "", actual, attachment.MaxContentBytes, "bytes", lower); err != nil {
			return err
		}
	}
	return i.transferStat(r, r.IDs["objectId"], expected)
}
func (i *Inspector) transferStat(r store.InputLimitsRecord, objectID string, expected int64) error {
	transferID := r.IDs["transferId"]
	if transferID == "" {
		transferID = r.IDs["id"]
	}
	ns, err := filestorage.NewTransferNamespace(transferID)
	if err != nil {
		return i.incomplete(r, "file", "invalid transfer namespace")
	}
	path, err := ns.ObjectPath(objectID)
	if err != nil {
		return i.incomplete(r, "file", "invalid transfer object")
	}
	if i.stat == nil {
		return i.incomplete(r, "file", "stat unavailable")
	}
	actual, err := i.stat(i.ctx, "mcp-transfers", path)
	if err != nil {
		i.outcome.Incomplete = true
		return err
	}
	if err = i.violation(r, attachment.AdmitContentSize(expected)); err != nil {
		return err
	}
	if err = i.violation(r, attachment.AdmitContentSize(actual)); err != nil {
		return err
	}
	if actual != expected {
		return i.finding(r, "sizeBytes", "violation", "metadata differs from file size", actual, expected, "bytes", false)
	}
	return nil
}
