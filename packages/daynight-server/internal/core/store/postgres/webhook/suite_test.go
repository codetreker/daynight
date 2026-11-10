package webhook

import (
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestWebhookCaptureStore(t *testing.T) {
	suite := newWebhookDAOSuite(t)
	suite.run(t, "CaptureBodyCapacityIsEnforcedByPostgreSQL", testCaptureBodyCapacityIsEnforcedByPostgreSQL)
	suite.run(t, "CaptureRejectsDuplicateEventWithoutAddingResponsibilities", testCaptureRejectsDuplicateEventWithoutAddingResponsibilities)
	suite.run(t, "AudiencePartialStreamFailureDiscardsSourceTransaction", testAudiencePartialStreamFailureDiscardsSourceTransaction)
	suite.run(t, "CapturedAuthorizationEpochDoesNotBecomeContinuousOnRegrant", testCapturedAuthorizationEpochDoesNotBecomeContinuousOnRegrant)
	suite.run(t, "EligibilityUnionAndCommittedAuthorizationGap/grant", func(t *testing.T, conn *pgx.Conn) {
		testEligibilityUnionAndCommittedAuthorizationGap(t, conn, "grant")
	})
	suite.run(t, "EligibilityUnionAndCommittedAuthorizationGap/membership", func(t *testing.T, conn *pgx.Conn) {
		testEligibilityUnionAndCommittedAuthorizationGap(t, conn, "membership")
	})
	suite.run(t, "EligibilityUnionRechecksAfterSubscriptionLockWait", testEligibilityUnionRechecksAfterSubscriptionLockWait)
	suite.run(t, "ActorAdmissionChecksAnchorsBeforeSourceLocks", testActorAdmissionChecksAnchorsBeforeSourceLocks)
	suite.run(t, "ActorAdmissionWaitsForCurrentTeamMembership", testActorAdmissionWaitsForCurrentTeamMembership)
	suite.run(t, "AdmissionSourcesDatabaseFailures", testAdmissionSourcesDatabaseFailures)
}

func TestWebhookDeliveryStore(t *testing.T) {
	suite := newWebhookDAOSuite(t)
	suite.run(t, "DeliveryDAOFailureAndBoundaryPaths", testDeliveryDAOFailureAndBoundaryPaths)
	suite.run(t, "DeliveryQueueOrderDoesNotRewindOnRollback", testDeliveryQueueOrderDoesNotRewindOnRollback)
	suite.run(t, "CurrentDestinationFollowsRevisionAndTombstone", testCurrentDestinationFollowsRevisionAndTombstone)
	suite.run(t, "AttemptManualIdentityRoundTripAndDuplicateRefusal", testAttemptManualIdentityRoundTripAndDuplicateRefusal)
}

func TestWebhookHistoryStore(t *testing.T) {
	suite := newWebhookDAOSuite(t)
	suite.run(t, "HistoryKeysetCursorSelectsOnlyFollowingDelivery", testHistoryKeysetCursorSelectsOnlyFollowingDelivery)
	suite.run(t, "HistorySourcesDistinguishTombstonesMissingFactsAndStorageFailures", testHistorySourcesDistinguishTombstonesMissingFactsAndStorageFailures)
	suite.run(t, "HistoryBatchJoinsFactsAndGroupsBothCollections", testHistoryBatchJoinsFactsAndGroupsBothCollections)
	suite.run(t, "HistoryBatchKeepsMissingEventsAndCurrentTombstones", testHistoryBatchKeepsMissingEventsAndCurrentTombstones)
	suite.run(t, "HistoryBatchReadsOneRepeatableReadSnapshot", testHistoryBatchReadsOneRepeatableReadSnapshot)
	suite.run(t, "HistoryBatchPropagatesActualRowsAndQueryFailures", testHistoryBatchPropagatesActualRowsAndQueryFailures)
	suite.run(t, "HistoryBatchDistinguishesReclaimedFactsFromMissingRequiredFields", testHistoryBatchDistinguishesReclaimedFactsFromMissingRequiredFields)
	suite.run(t, "HistoryBatchCancellationReleasesThePoolConnection", testHistoryBatchCancellationReleasesThePoolConnection)
	suite.run(t, "HistoryReadersPropagateDatabaseAndPartialReadFailures", testHistoryReadersPropagateDatabaseAndPartialReadFailures)
	suite.run(t, "MissingAdmissionEventRetentionAndStorageFailures", testMissingAdmissionEventRetentionAndStorageFailures)
	suite.run(t, "HistoryDisclosureTracksCommittedSourceChangesWithoutSubscriptions", testHistoryDisclosureTracksCommittedSourceChangesWithoutSubscriptions)
	suite.run(t, "HistoryDisclosureIgnoresRetentionAndPostCutoffRecords", testHistoryDisclosureIgnoresRetentionAndPostCutoffRecords)
	suite.run(t, "HistoryMetadataExpiresUsingFreshTransactionClock", testHistoryMetadataExpiresUsingFreshTransactionClock)
}

func TestWebhookRetentionStore(t *testing.T) {
	suite := newWebhookDAOSuite(t)
	suite.run(t, "RetentionCandidateDeadlineAndActivityPredicates", testRetentionCandidateDeadlineAndActivityPredicates)
	suite.run(t, "RetentionCandidateSkipsLockedDelivery", testRetentionCandidateSkipsLockedDelivery)
	suite.run(t, "RetentionClosureAndLateAttemptUseRealLockOrder/late", func(t *testing.T, conn *pgx.Conn) {
		testRetentionClosureAndLateAttemptUseRealLockOrder(t, conn, "late")
	})
	suite.run(t, "RetentionClosureAndLateAttemptUseRealLockOrder/close", func(t *testing.T, conn *pgx.Conn) {
		testRetentionClosureAndLateAttemptUseRealLockOrder(t, conn, "close")
	})
	suite.run(t, "RetentionChildrenHonorSQLBudgetAcrossFreshDAOs/match_limit", func(t *testing.T, conn *pgx.Conn) {
		testRetentionChildrenHonorSQLBudgetAcrossFreshDAOs(t, conn, retentionSQLBudgetShape{501, 1, 1, 1})
	})
	suite.run(t, "RetentionChildrenHonorSQLBudgetAcrossFreshDAOs/attempt_remaining_limit", func(t *testing.T, conn *pgx.Conn) {
		testRetentionChildrenHonorSQLBudgetAcrossFreshDAOs(t, conn, retentionSQLBudgetShape{499, 2, 0, 1})
	})
	suite.run(t, "SharedEventRetentionWaitsForEveryOwnerReference", testSharedEventRetentionWaitsForEveryOwnerReference)
	suite.run(t, "RetentionPolicyRequiresStoredVersion", testRetentionPolicyRequiresStoredVersion)
}
