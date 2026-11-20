package usage

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
)

type Service struct {
	database     store.UsageStore
	writeEnabled bool
	qualified    map[string]bool
}
type Options struct {
	WriteEnabled      bool
	QualifiedProfiles []string
}

func New(database store.UsageStore, options Options) (*Service, error) {
	q, err := qualificationEntries(options.QualifiedProfiles)
	if err != nil {
		return nil, err
	}
	return &Service{database: database, writeEnabled: options.WriteEnabled, qualified: q}, nil
}
func (s *Service) qualify(p core.Profile, version string) core.Profile {
	return core.Qualify(p, s.qualified[p.ID+"@"+version])
}
func (s *Service) profile(id, provider, version string) (core.Profile, error) {
	p, e := core.FindProfile(id, provider)
	return s.qualify(p, version), e
}

type qualifiedVersion struct {
	ProviderVersion string                `json:"providerVersion"`
	Capability      model.UsageCapability `json:"capability"`
}
type profileAdvertisement struct {
	core.Profile
	QualifiedVersions []qualifiedVersion `json:"qualifiedVersions"`
}

func (s *Service) Capabilities() map[string]any {
	profiles := []profileAdvertisement{}
	for _, p := range core.Profiles() {
		entry := profileAdvertisement{Profile: p, QualifiedVersions: []qualifiedVersion{}}
		versions := []string{}
		for key := range s.qualified {
			if version, ok := strings.CutPrefix(key, p.ID+"@"); ok {
				versions = append(versions, version)
			}
		}
		sort.Strings(versions)
		for _, version := range versions {
			entry.QualifiedVersions = append(entry.QualifiedVersions, qualifiedVersion{version, s.qualify(p, version).Capability})
		}
		profiles = append(profiles, entry)
	}
	return map[string]any{"protocol": core.Protocol, "schemaVersion": 1, "writeEnabled": s.writeEnabled, "taskSummary": true, "aggregates": true, "maxBatchTasks": 100, "maxEvents": 100, "maxPageSize": 100, "profiles": profiles}
}
func (s *Service) write(ctx context.Context, f func(store.UsageScope) error) error {
	if !s.writeEnabled {
		return core.Fault("write_disabled")
	}
	completion, err := s.database.WriteUsage(ctx, f)
	if completion.Outcome == store.TransactionUnknown {
		return errors.Join(core.Fault("write_outcome_unknown"), err)
	}
	if err != nil {
		return err
	}
	if completion.Outcome != store.TransactionCommitted {
		return core.Fault("write_not_committed")
	}
	return nil
}
func expiry(now, created time.Time) time.Time {
	a, b := now.Add(7*24*time.Hour), created.Add(90*24*time.Hour)
	if b.Before(a) {
		return b
	}
	return a
}
func authorizeTask(a store.UsageAuthorization) error {
	if !a.AllowAgents || a.Paused {
		return core.Fault("permission_revoked")
	}
	return nil
}
func (s *Service) authority(ctx context.Context, scope store.UsageScope, session store.UsageSession, user, parent string, write bool) (store.UsageAuthorization, error) {
	dao := scope.UsageDAO()
	var a store.UsageAuthorization
	var err error
	if session.Scope == "task" {
		if write {
			a, err = dao.LockTask(ctx, session)
		} else {
			a, err = dao.ReadTask(ctx, session)
		}
		if err != nil {
			return a, err
		}
	}
	valid, err := dao.ParentValid(ctx, parent, user, write)
	if err != nil {
		return a, err
	}
	if !valid {
		return a, core.Fault("permission_revoked")
	}
	if write {
		if _, err = scope.SessionDAO().LockSession(ctx, session.ID); err != nil {
			return a, err
		}
	}
	if session.Scope == "task" {
		a.Access, err = dao.ProjectAccess(ctx, user, *session.ProjectID, write)
		if err != nil {
			return a, core.Fault("permission_revoked")
		}
		if err = authorizeTask(a); err != nil {
			return a, err
		}
	}
	valid, err = dao.ParentValid(ctx, parent, user, false)
	if err != nil {
		return a, err
	}
	if !valid {
		return a, core.Fault("permission_revoked")
	}
	return a, nil
}
func readPermission(ctx context.Context, scope store.UsageScope, p model.Principal, session store.UsageSession, admin bool) (string, error) {
	if session.BotID != nil {
		return "", core.Fault("resource_unavailable")
	}
	dao := scope.UsageDAO()
	now, err := dao.Now(ctx)
	if err != nil {
		return "", err
	}
	if err = scope.SessionDAO().ReadCredential(ctx, p, now); err != nil {
		return "", err
	}
	if session.Scope == "test" {
		if p.UserID != session.OwnerID {
			return "", core.Fault("resource_unavailable")
		}
		return p.UserID, nil
	}
	a, err := dao.ProjectAccess(ctx, p.UserID, *session.ProjectID, false)
	if err != nil {
		return "", core.Fault("resource_unavailable")
	}
	members, err := dao.Tasks(ctx, *session.ProjectID, []string{core.Value(session.TaskID)})
	if err != nil {
		return "", err
	}
	if len(members) != 1 {
		return "", core.Fault("resource_unavailable")
	}
	if admin && p.UserID != session.OwnerID && a.Role != model.ProjectAdmin {
		return "", core.Fault("resource_unavailable")
	}
	epoch, err := dao.PermissionEpoch(ctx, p.UserID, *session.ProjectID)
	if err != nil {
		return "", err
	}
	token, err := authToken(p, a)
	if err != nil {
		return "", err
	}
	return core.Hash([]any{token, epoch})
}
func (s *Service) State(ctx context.Context, p model.Principal, id string) (model.UsageRecord, error) {
	var r model.UsageRecord
	err := s.database.ReadUsage(ctx, func(scope store.UsageScope) error {
		var err error
		r, err = scope.UsageDAO().State(ctx, id)
		if err != nil {
			return err
		}
		session, err := scope.UsageDAO().Session(ctx, r.SessionID)
		if err != nil {
			return err
		}
		if _, err = readPermission(ctx, scope, p, session, true); err != nil {
			return err
		}
		now, err := scope.UsageDAO().Now(ctx)
		if err != nil {
			return err
		}
		executions, err := scope.UsageDAO().Executions(ctx, store.UsageFilter{SessionID: r.SessionID, ObservedAt: now})
		if err != nil {
			return err
		}
		for _, e := range executions {
			if e.State != nil && e.State.ID == r.ID {
				state, reasons := core.Effective(r, core.EffectiveFacts{Expired: r.GrantExpiresAt == nil || !now.Before(*r.GrantExpiresAt), Revoked: r.GrantRevokedAt != nil || !e.ParentValid || !e.Allowed, Stopped: e.Stopped, Known: e.Known, GapReasons: e.GapReasons})
				r.EffectiveCollectionState = &state
				r.ReasonCodes = reasons
				break
			}
		}
		return nil
	})
	return r, err
}
func orderedIDs(records map[string]model.UsageRecord) []string {
	keys := make([]string, 0, len(records))
	for k := range records {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
