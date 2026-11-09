package webhook

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type mgmtTrace struct {
	mu    sync.Mutex
	calls []string
}

func (r *mgmtTrace) add(call string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, call)
}
func (r *mgmtTrace) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.calls...)
}

type mgmtMockBase struct {
	t     *testing.T
	trace *mgmtTrace
	label string
}

func (m mgmtMockBase) need(method string, configured bool) {
	m.t.Helper()
	name := m.label + "." + method
	m.trace.add(name)
	if !configured {
		m.t.Errorf("unexpected DAO call %s", name)
		panic(fmt.Sprintf("unexpected DAO call %s", name))
	}
}

type mgmtWebhookDAO struct {
	HistoryBatchFn         func(context.Context, wm.Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error)
	HistoryMatchesFn       func(context.Context, []string) ([]store.WebhookHistoryMatch, error)
	HistoryBatchAttemptsFn func(context.Context, []string) ([]store.WebhookAttempt, error)
	mgmtMockBase
	EndpointFn          func(context.Context, wm.Owner, string) (wm.Endpoint, error)
	EndpointsFn         func(context.Context, wm.Owner) ([]wm.Endpoint, error)
	SigningKeysFn       func(context.Context, string) ([]wm.SigningKey, error)
	SubscriptionsFn     func(context.Context, string) ([]wm.Subscription, error)
	BindingsFn          func(context.Context, string) ([]wm.Binding, error)
	OperationFn         func(context.Context, wm.Owner, string) (wm.Operation, error)
	PolicyFn            func(context.Context, int64) (wm.Policy, error)
	LockEndpointFn      func(context.Context, wm.Owner, string) (wm.Endpoint, error)
	LockSubscriptionsFn func(context.Context, string) ([]wm.Subscription, error)
	PutSubscriptionFn   func(context.Context, wm.Subscription) error
	PutBindingFn        func(context.Context, wm.Binding) error
	PutEndpointFn       func(context.Context, wm.Endpoint) error
	PutSigningKeyFn     func(context.Context, wm.SigningKey) error
	DeleteSigningKeysFn func(context.Context, string) error
	PutOperationFn      func(context.Context, wm.Operation) error
	HistoryDeliveriesFn func(context.Context, wm.Owner, string, time.Time, string, int) ([]store.WebhookDelivery, error)
	HistoryDeliveryFn   func(context.Context, wm.Owner, string, string) (store.WebhookDelivery, error)
	HistorySourcesFn    func(context.Context, store.WebhookDelivery, string) (store.WebhookHistorySources, error)
	HistoryDisclosureFn func(context.Context, wm.Owner, string, string, time.Time) (string, error)
	HistoryAttemptsFn   func(context.Context, string) ([]store.WebhookAttempt, error)
	LatestAttemptFn     func(context.Context, string) (*store.WebhookAttempt, error)
}

func (m *mgmtWebhookDAO) Endpoint(p0 context.Context, p1 wm.Owner, p2 string) (wm.Endpoint, error) {
	m.need("Endpoint", m.EndpointFn != nil)
	return m.EndpointFn(p0, p1, p2)
}
func (m *mgmtWebhookDAO) Endpoints(p0 context.Context, p1 wm.Owner) ([]wm.Endpoint, error) {
	m.need("Endpoints", m.EndpointsFn != nil)
	return m.EndpointsFn(p0, p1)
}
func (m *mgmtWebhookDAO) SigningKeys(p0 context.Context, p1 string) ([]wm.SigningKey, error) {
	m.need("SigningKeys", m.SigningKeysFn != nil)
	return m.SigningKeysFn(p0, p1)
}
func (m *mgmtWebhookDAO) Subscriptions(p0 context.Context, p1 string) ([]wm.Subscription, error) {
	m.need("Subscriptions", m.SubscriptionsFn != nil)
	return m.SubscriptionsFn(p0, p1)
}
func (m *mgmtWebhookDAO) Bindings(p0 context.Context, p1 string) ([]wm.Binding, error) {
	m.need("Bindings", m.BindingsFn != nil)
	return m.BindingsFn(p0, p1)
}
func (m *mgmtWebhookDAO) Operation(p0 context.Context, p1 wm.Owner, p2 string) (wm.Operation, error) {
	m.need("Operation", m.OperationFn != nil)
	return m.OperationFn(p0, p1, p2)
}
func (m *mgmtWebhookDAO) Policy(p0 context.Context, p1 int64) (wm.Policy, error) {
	m.need("Policy", m.PolicyFn != nil)
	return m.PolicyFn(p0, p1)
}
func (m *mgmtWebhookDAO) LockEndpoint(p0 context.Context, p1 wm.Owner, p2 string) (wm.Endpoint, error) {
	m.need("LockEndpoint", m.LockEndpointFn != nil)
	return m.LockEndpointFn(p0, p1, p2)
}
func (m *mgmtWebhookDAO) LockSubscriptions(p0 context.Context, p1 string) ([]wm.Subscription, error) {
	m.need("LockSubscriptions", m.LockSubscriptionsFn != nil)
	return m.LockSubscriptionsFn(p0, p1)
}
func (m *mgmtWebhookDAO) PutSubscription(p0 context.Context, p1 wm.Subscription) error {
	m.need("PutSubscription", m.PutSubscriptionFn != nil)
	return m.PutSubscriptionFn(p0, p1)
}
func (m *mgmtWebhookDAO) PutBinding(p0 context.Context, p1 wm.Binding) error {
	m.need("PutBinding", m.PutBindingFn != nil)
	return m.PutBindingFn(p0, p1)
}
func (m *mgmtWebhookDAO) PutEndpoint(p0 context.Context, p1 wm.Endpoint) error {
	m.need("PutEndpoint", m.PutEndpointFn != nil)
	return m.PutEndpointFn(p0, p1)
}
func (m *mgmtWebhookDAO) PutSigningKey(p0 context.Context, p1 wm.SigningKey) error {
	m.need("PutSigningKey", m.PutSigningKeyFn != nil)
	return m.PutSigningKeyFn(p0, p1)
}
func (m *mgmtWebhookDAO) DeleteSigningKeys(p0 context.Context, p1 string) error {
	m.need("DeleteSigningKeys", m.DeleteSigningKeysFn != nil)
	return m.DeleteSigningKeysFn(p0, p1)
}
func (m *mgmtWebhookDAO) PutOperation(p0 context.Context, p1 wm.Operation) error {
	m.need("PutOperation", m.PutOperationFn != nil)
	return m.PutOperationFn(p0, p1)
}
func (m *mgmtWebhookDAO) HistoryBatch(c context.Context, o wm.Owner, e, actor string, at time.Time, id string, n int) (store.WebhookHistoryBatch, error) {
	m.need("HistoryBatch", m.HistoryBatchFn != nil)
	return m.HistoryBatchFn(c, o, e, actor, at, id, n)
}
func (m *mgmtWebhookDAO) HistoryMatches(c context.Context, ids []string) ([]store.WebhookHistoryMatch, error) {
	m.need("HistoryMatches", m.HistoryMatchesFn != nil)
	return m.HistoryMatchesFn(c, ids)
}
func (m *mgmtWebhookDAO) HistoryBatchAttempts(c context.Context, ids []string) ([]store.WebhookAttempt, error) {
	m.need("HistoryBatchAttempts", m.HistoryBatchAttemptsFn != nil)
	return m.HistoryBatchAttemptsFn(c, ids)
}
func (m *mgmtWebhookDAO) HistoryDeliveries(p0 context.Context, p1 wm.Owner, p2 string, p3 time.Time, p4 string, p5 int) ([]store.WebhookDelivery, error) {
	m.need("HistoryDeliveries", m.HistoryDeliveriesFn != nil)
	return m.HistoryDeliveriesFn(p0, p1, p2, p3, p4, p5)
}
func (m *mgmtWebhookDAO) HistoryDelivery(p0 context.Context, p1 wm.Owner, p2 string, p3 string) (store.WebhookDelivery, error) {
	m.need("HistoryDelivery", m.HistoryDeliveryFn != nil)
	return m.HistoryDeliveryFn(p0, p1, p2, p3)
}
func (m *mgmtWebhookDAO) HistorySources(p0 context.Context, p1 store.WebhookDelivery, p2 string) (store.WebhookHistorySources, error) {
	m.need("HistorySources", m.HistorySourcesFn != nil)
	return m.HistorySourcesFn(p0, p1, p2)
}
func (m *mgmtWebhookDAO) HistoryDisclosure(p0 context.Context, p1 wm.Owner, p2 string, p3 string, p4 time.Time) (string, error) {
	m.need("HistoryDisclosure", m.HistoryDisclosureFn != nil)
	return m.HistoryDisclosureFn(p0, p1, p2, p3, p4)
}
func (m *mgmtWebhookDAO) HistoryAttempts(p0 context.Context, p1 string) ([]store.WebhookAttempt, error) {
	m.need("HistoryAttempts", m.HistoryAttemptsFn != nil)
	return m.HistoryAttemptsFn(p0, p1)
}
func (m *mgmtWebhookDAO) LatestAttempt(p0 context.Context, p1 string) (*store.WebhookAttempt, error) {
	m.need("LatestAttempt", m.LatestAttemptFn != nil)
	return m.LatestAttemptFn(p0, p1)
}

type mgmtTeamDAO struct {
	mgmtMockBase
	TeamFn                 func(context.Context, string, string) (model.Team, error)
	TeamAccessFn           func(context.Context, string, string) error
	TeamsFn                func(context.Context, string, store.Page) (store.TeamPage, error)
	TeamMembersFn          func(context.Context, string) ([]model.TeamMemberProfile, error)
	TeamMembersPageFn      func(context.Context, string, store.Page) (store.TeamMemberPage, error)
	TeamInvitationFn       func(context.Context, []byte) (model.TeamInvitation, error)
	TeamInvitationsFn      func(context.Context, string, time.Time) ([]model.TeamInvitation, error)
	TeamInvitationPageFn   func(context.Context, string, time.Time, store.Page) (store.TeamInvitationPage, error)
	InvitationTeamFn       func(context.Context, string) (model.TeamRef, error)
	InvitationTeamMemberFn func(context.Context, string, string) (model.TeamMember, error)
}

func (m *mgmtTeamDAO) Team(p0 context.Context, p1 string, p2 string) (model.Team, error) {
	m.need("Team", m.TeamFn != nil)
	return m.TeamFn(p0, p1, p2)
}
func (m *mgmtTeamDAO) TeamAccess(p0 context.Context, p1 string, p2 string) error {
	m.need("TeamAccess", m.TeamAccessFn != nil)
	return m.TeamAccessFn(p0, p1, p2)
}
func (m *mgmtTeamDAO) Teams(p0 context.Context, p1 string, p2 store.Page) (store.TeamPage, error) {
	m.need("Teams", m.TeamsFn != nil)
	return m.TeamsFn(p0, p1, p2)
}
func (m *mgmtTeamDAO) TeamMembers(p0 context.Context, p1 string) ([]model.TeamMemberProfile, error) {
	m.need("TeamMembers", m.TeamMembersFn != nil)
	return m.TeamMembersFn(p0, p1)
}
func (m *mgmtTeamDAO) TeamMembersPage(p0 context.Context, p1 string, p2 store.Page) (store.TeamMemberPage, error) {
	m.need("TeamMembersPage", m.TeamMembersPageFn != nil)
	return m.TeamMembersPageFn(p0, p1, p2)
}
func (m *mgmtTeamDAO) TeamInvitation(p0 context.Context, p1 []byte) (model.TeamInvitation, error) {
	m.need("TeamInvitation", m.TeamInvitationFn != nil)
	return m.TeamInvitationFn(p0, p1)
}
func (m *mgmtTeamDAO) TeamInvitations(p0 context.Context, p1 string, p2 time.Time) ([]model.TeamInvitation, error) {
	m.need("TeamInvitations", m.TeamInvitationsFn != nil)
	return m.TeamInvitationsFn(p0, p1, p2)
}
func (m *mgmtTeamDAO) TeamInvitationPage(p0 context.Context, p1 string, p2 time.Time, p3 store.Page) (store.TeamInvitationPage, error) {
	m.need("TeamInvitationPage", m.TeamInvitationPageFn != nil)
	return m.TeamInvitationPageFn(p0, p1, p2, p3)
}
func (m *mgmtTeamDAO) InvitationTeam(p0 context.Context, p1 string) (model.TeamRef, error) {
	m.need("InvitationTeam", m.InvitationTeamFn != nil)
	return m.InvitationTeamFn(p0, p1)
}
func (m *mgmtTeamDAO) InvitationTeamMember(p0 context.Context, p1 string, p2 string) (model.TeamMember, error) {
	m.need("InvitationTeamMember", m.InvitationTeamMemberFn != nil)
	return m.InvitationTeamMemberFn(p0, p1, p2)
}

type mgmtEligibilityDAO struct {
	mgmtMockBase
	ReadEligibilityFn func(context.Context, wm.Owner, string, string) (store.WebhookEligibility, error)
	LockAffectedFn    func(context.Context, store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error)
	RevokeFn          func(context.Context, string, int64) error
}

func (m *mgmtEligibilityDAO) ReadEligibility(p0 context.Context, p1 wm.Owner, p2 string, p3 string) (store.WebhookEligibility, error) {
	m.need("ReadEligibility", m.ReadEligibilityFn != nil)
	return m.ReadEligibilityFn(p0, p1, p2, p3)
}
func (m *mgmtEligibilityDAO) LockAffected(p0 context.Context, p1 store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	m.need("LockAffected", m.LockAffectedFn != nil)
	return m.LockAffectedFn(p0, p1)
}
func (m *mgmtEligibilityDAO) Revoke(p0 context.Context, p1 string, p2 int64) error {
	m.need("Revoke", m.RevokeFn != nil)
	return m.RevokeFn(p0, p1, p2)
}

type mgmtRedeliveryDAO struct {
	mgmtMockBase
	AdmissionSourcesForActorFn func(context.Context, string, string, wm.Owner, string, time.Time) (store.WebhookAdmissionSources, error)
	LockDeliveryFn             func(context.Context, string) (store.WebhookDelivery, error)
	LockAttemptsFn             func(context.Context, string) ([]store.WebhookAttempt, error)
	UpdateAttemptFn            func(context.Context, store.WebhookAttempt) error
	UpdateDeliveryFn           func(context.Context, store.WebhookDelivery) error
	NextQueueOrderFn           func(context.Context) (int64, error)
}

func (m *mgmtRedeliveryDAO) AdmissionSourcesForActor(p0 context.Context, p1 string, p2 string, p3 wm.Owner, p4 string, p5 time.Time) (store.WebhookAdmissionSources, error) {
	m.need("AdmissionSourcesForActor", m.AdmissionSourcesForActorFn != nil)
	return m.AdmissionSourcesForActorFn(p0, p1, p2, p3, p4, p5)
}
func (m *mgmtRedeliveryDAO) LockDelivery(p0 context.Context, p1 string) (store.WebhookDelivery, error) {
	m.need("LockDelivery", m.LockDeliveryFn != nil)
	return m.LockDeliveryFn(p0, p1)
}
func (m *mgmtRedeliveryDAO) LockAttempts(p0 context.Context, p1 string) ([]store.WebhookAttempt, error) {
	m.need("LockAttempts", m.LockAttemptsFn != nil)
	return m.LockAttemptsFn(p0, p1)
}
func (m *mgmtRedeliveryDAO) UpdateAttempt(p0 context.Context, p1 store.WebhookAttempt) error {
	m.need("UpdateAttempt", m.UpdateAttemptFn != nil)
	return m.UpdateAttemptFn(p0, p1)
}
func (m *mgmtRedeliveryDAO) UpdateDelivery(p0 context.Context, p1 store.WebhookDelivery) error {
	m.need("UpdateDelivery", m.UpdateDeliveryFn != nil)
	return m.UpdateDeliveryFn(p0, p1)
}
func (m *mgmtRedeliveryDAO) NextQueueOrder(p0 context.Context) (int64, error) {
	m.need("NextQueueOrder", m.NextQueueOrderFn != nil)
	return m.NextQueueOrderFn(p0)
}

type mgmtCredentialDAO struct {
	mgmtMockBase
	CredentialFn func(context.Context, model.Principal) (store.ThreadCredential, error)
}

func (m *mgmtCredentialDAO) Credential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	m.need("Credential", m.CredentialFn != nil)
	return m.CredentialFn(ctx, p)
}

type mgmtScope struct {
	mgmtMockBase
	credential                 store.CredentialReader
	team                       store.TeamReader
	reader                     store.WebhookReader
	writer                     store.WebhookWriter
	eligibility                store.WebhookEligibilityDAO
	redelivery                 store.WebhookRedeliveryScope
	ObservedAtFn               func(context.Context) (time.Time, error)
	LockConfigurationSourcesFn func(context.Context, wm.Owner, string, []string) error
	LockAuthorityFn            func(context.Context, wm.Owner, string) error
	LockCredentialFn           func(context.Context, model.Principal) (store.ThreadCredential, error)
}

func (m *mgmtScope) CredentialDAO() store.CredentialReader {
	m.need("CredentialDAO", m.credential != nil)
	return m.credential
}
func (m *mgmtScope) TeamDAO() store.TeamReader { m.need("TeamDAO", m.team != nil); return m.team }
func (m *mgmtScope) WebhookDAO() store.WebhookReader {
	m.need("WebhookDAO", m.reader != nil)
	return m.reader
}
func (m *mgmtScope) WebhookWriter() store.WebhookWriter {
	m.need("WebhookWriter", m.writer != nil)
	return m.writer
}
func (m *mgmtScope) EligibilityDAO() store.WebhookEligibilityDAO {
	m.need("EligibilityDAO", m.eligibility != nil)
	return m.eligibility
}
func (m *mgmtScope) RedeliveryWriter() store.WebhookRedeliveryScope {
	m.need("RedeliveryWriter", m.redelivery != nil)
	return m.redelivery
}
func (m *mgmtScope) ObservedAt(ctx context.Context) (time.Time, error) {
	m.need("ObservedAt", m.ObservedAtFn != nil)
	return m.ObservedAtFn(ctx)
}
func (m *mgmtScope) LockConfigurationSources(ctx context.Context, o wm.Owner, actor string, projects []string) error {
	m.need("LockConfigurationSources", m.LockConfigurationSourcesFn != nil)
	return m.LockConfigurationSourcesFn(ctx, o, actor, projects)
}
func (m *mgmtScope) LockAuthority(ctx context.Context, o wm.Owner, actor string) error {
	m.need("LockAuthority", m.LockAuthorityFn != nil)
	return m.LockAuthorityFn(ctx, o, actor)
}
func (m *mgmtScope) LockCredential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	m.need("LockCredential", m.LockCredentialFn != nil)
	return m.LockCredentialFn(ctx, p)
}

type mgmtTransactions struct {
	mgmtMockBase
	WriteFn func(context.Context, wm.Owner, string, func(store.WebhookWriteScope) error) (store.Completion, error)
	ReadFn  func(context.Context, func(store.WebhookReadScope) error) error
}

func (m *mgmtTransactions) WriteWebhook(ctx context.Context, o wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
	m.need("WriteWebhook", m.WriteFn != nil)
	return m.WriteFn(ctx, o, id, fn)
}
func (m *mgmtTransactions) ReadWebhookSnapshot(ctx context.Context, fn func(store.WebhookReadScope) error) error {
	m.need("ReadWebhookSnapshot", m.ReadFn != nil)
	return m.ReadFn(ctx, fn)
}
