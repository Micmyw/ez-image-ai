/**
 * Prisma Zod Generator - Single File (inlined)
 * Auto-generated. Do not edit.
 */

import * as z from 'zod';
// File: TransactionIsolationLevel.schema.ts

export const TransactionIsolationLevelSchema = z.enum(['ReadUncommitted', 'ReadCommitted', 'RepeatableRead', 'Serializable'])

export type TransactionIsolationLevel = z.infer<typeof TransactionIsolationLevelSchema>;

// File: UserScalarFieldEnum.schema.ts

export const UserScalarFieldEnumSchema = z.enum(['id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt', 'role', 'banned', 'banReason', 'banExpires', 'onboardingComplete', 'paymentsCustomerId', 'locale', 'twoFactorEnabled', 'lastActiveOrganizationId'])

export type UserScalarFieldEnum = z.infer<typeof UserScalarFieldEnumSchema>;

// File: SessionScalarFieldEnum.schema.ts

export const SessionScalarFieldEnumSchema = z.enum(['id', 'expiresAt', 'ipAddress', 'userAgent', 'userId', 'impersonatedBy', 'activeOrganizationId', 'token', 'createdAt', 'updatedAt'])

export type SessionScalarFieldEnum = z.infer<typeof SessionScalarFieldEnumSchema>;

// File: AccountScalarFieldEnum.schema.ts

export const AccountScalarFieldEnumSchema = z.enum(['id', 'accountId', 'providerId', 'userId', 'accessToken', 'refreshToken', 'idToken', 'expiresAt', 'password', 'accessTokenExpiresAt', 'refreshTokenExpiresAt', 'scope', 'createdAt', 'updatedAt'])

export type AccountScalarFieldEnum = z.infer<typeof AccountScalarFieldEnumSchema>;

// File: VerificationScalarFieldEnum.schema.ts

export const VerificationScalarFieldEnumSchema = z.enum(['id', 'identifier', 'value', 'expiresAt', 'createdAt', 'updatedAt'])

export type VerificationScalarFieldEnum = z.infer<typeof VerificationScalarFieldEnumSchema>;

// File: PasskeyScalarFieldEnum.schema.ts

export const PasskeyScalarFieldEnumSchema = z.enum(['id', 'name', 'publicKey', 'userId', 'credentialID', 'counter', 'deviceType', 'backedUp', 'transports', 'aaguid', 'createdAt'])

export type PasskeyScalarFieldEnum = z.infer<typeof PasskeyScalarFieldEnumSchema>;

// File: TwoFactorScalarFieldEnum.schema.ts

export const TwoFactorScalarFieldEnumSchema = z.enum(['id', 'secret', 'backupCodes', 'verified', 'userId', 'failedVerificationCount', 'lockedUntil'])

export type TwoFactorScalarFieldEnum = z.infer<typeof TwoFactorScalarFieldEnumSchema>;

// File: OrganizationScalarFieldEnum.schema.ts

export const OrganizationScalarFieldEnumSchema = z.enum(['id', 'name', 'slug', 'logo', 'createdAt', 'metadata', 'paymentsCustomerId'])

export type OrganizationScalarFieldEnum = z.infer<typeof OrganizationScalarFieldEnumSchema>;

// File: MemberScalarFieldEnum.schema.ts

export const MemberScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'userId', 'role', 'createdAt'])

export type MemberScalarFieldEnum = z.infer<typeof MemberScalarFieldEnumSchema>;

// File: InvitationScalarFieldEnum.schema.ts

export const InvitationScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'email', 'role', 'status', 'expiresAt', 'inviterId', 'createdAt'])

export type InvitationScalarFieldEnum = z.infer<typeof InvitationScalarFieldEnumSchema>;

// File: PurchaseScalarFieldEnum.schema.ts

export const PurchaseScalarFieldEnumSchema = z.enum(['id', 'organizationId', 'userId', 'type', 'customerId', 'subscriptionId', 'priceId', 'status', 'createdAt', 'updatedAt'])

export type PurchaseScalarFieldEnum = z.infer<typeof PurchaseScalarFieldEnumSchema>;

// File: GenerationQuoteScalarFieldEnum.schema.ts

export const GenerationQuoteScalarFieldEnumSchema = z.enum(['id', 'ownerType', 'ownerId', 'submittedByUserId', 'productKey', 'catalogVersion', 'pricingVersion', 'credits', 'costMicros', 'inputSnapshot', 'pricingSnapshot', 'moderationDecision', 'moderationProvider', 'moderationRuleVersion', 'moderationReasonCode', 'inputFingerprint', 'createdAt', 'expiresAt'])

export type GenerationQuoteScalarFieldEnum = z.infer<typeof GenerationQuoteScalarFieldEnumSchema>;

// File: GenerationJobScalarFieldEnum.schema.ts

export const GenerationJobScalarFieldEnumSchema = z.enum(['id', 'ownerType', 'ownerId', 'submittedByUserId', 'quoteId', 'idempotencyKey', 'productKey', 'catalogVersion', 'pricingVersion', 'creditsReserved', 'inputSnapshot', 'pricingSnapshot', 'status', 'version', 'failureCode', 'failureMessage', 'finalizationStage', 'finalizationRetryCount', 'finalizationErrorCode', 'nextFinalizeAt', 'createdAt', 'updatedAt', 'terminalAt'])

export type GenerationJobScalarFieldEnum = z.infer<typeof GenerationJobScalarFieldEnumSchema>;

// File: GenerationAttemptScalarFieldEnum.schema.ts

export const GenerationAttemptScalarFieldEnumSchema = z.enum(['id', 'jobId', 'attemptNumber', 'provider', 'providerModelId', 'providerTaskId', 'providerStatusUrl', 'providerResultUrl', 'submissionToken', 'status', 'providerCostMicros', 'progress', 'lastProviderEventAt', 'lastProviderOccurredAt', 'lastProviderReceivedAt', 'lastProviderSequence', 'uncertainSubmission', 'reconciliationCount', 'nextReconcileAt', 'reconcileLeaseToken', 'reconcileLeasedUntil', 'requestSnapshot', 'responseSnapshot', 'errorSnapshot', 'createdAt', 'updatedAt', 'submittedAt', 'completedAt'])

export type GenerationAttemptScalarFieldEnum = z.infer<typeof GenerationAttemptScalarFieldEnumSchema>;

// File: GenerationAttemptTransferEnvelopeScalarFieldEnum.schema.ts

export const GenerationAttemptTransferEnvelopeScalarFieldEnumSchema = z.enum(['attemptId', 'payload', 'createdAt', 'updatedAt'])

export type GenerationAttemptTransferEnvelopeScalarFieldEnum = z.infer<typeof GenerationAttemptTransferEnvelopeScalarFieldEnumSchema>;

// File: MediaAssetScalarFieldEnum.schema.ts

export const MediaAssetScalarFieldEnumSchema = z.enum(['id', 'ownerType', 'ownerId', 'kind', 'status', 'objectKey', 'mimeType', 'byteSize', 'width', 'height', 'durationMillis', 'checksum', 'storageEtag', 'storageVersionId', 'finalizedAt', 'outputTransferToken', 'outputTransferLeaseExpiresAt', 'outputStagingObjectKey', 'outputPromotionMultipartUploadId', 'sourceUrl', 'verificationGeneration', 'verificationAttemptCount', 'verificationProvider', 'verificationRuleVersion', 'verificationPolicyVersion', 'verificationProviderTaskId', 'verificationLeaseToken', 'verificationLeasedUntil', 'verificationNextAttemptAt', 'verificationDeadlineAt', 'verificationExhaustedAt', 'verificationValidUntil', 'verificationSubmissionToken', 'verificationSubmissionUncertain', 'verificationSubmittedAt', 'verificationLastErrorCode', 'createdAt', 'updatedAt', 'deletedAt'])

export type MediaAssetScalarFieldEnum = z.infer<typeof MediaAssetScalarFieldEnumSchema>;

// File: MediaUploadSessionScalarFieldEnum.schema.ts

export const MediaUploadSessionScalarFieldEnumSchema = z.enum(['id', 'assetId', 'tokenHash', 'multipartUploadId', 'stagingObjectKey', 'stagedTerminalizationToken', 'promotionMultipartUploadId', 'promotionToken', 'finalizationToken', 'finalizationLeaseExpiresAt', 'legacyFinalizationToken', 'finalizationParts', 'status', 'expectedBytes', 'createdAt', 'expiresAt', 'completedAt'])

export type MediaUploadSessionScalarFieldEnum = z.infer<typeof MediaUploadSessionScalarFieldEnumSchema>;

// File: GenerationJobAssetScalarFieldEnum.schema.ts

export const GenerationJobAssetScalarFieldEnumSchema = z.enum(['id', 'jobId', 'assetId', 'assetChecksum', 'role', 'position', 'createdAt'])

export type GenerationJobAssetScalarFieldEnum = z.infer<typeof GenerationJobAssetScalarFieldEnumSchema>;

// File: AssetModerationResultScalarFieldEnum.schema.ts

export const AssetModerationResultScalarFieldEnumSchema = z.enum(['id', 'assetId', 'assetChecksum', 'verificationGeneration', 'attemptNumber', 'evidenceKind', 'provider', 'providerTaskId', 'ruleVersion', 'policyVersion', 'status', 'reasonCode', 'categories', 'rawEnvelope', 'validUntil', 'createdAt'])

export type AssetModerationResultScalarFieldEnum = z.infer<typeof AssetModerationResultScalarFieldEnumSchema>;

// File: GenerationRetryRequestScalarFieldEnum.schema.ts

export const GenerationRetryRequestScalarFieldEnumSchema = z.enum(['id', 'ownerType', 'ownerId', 'submittedByUserId', 'sourceJobId', 'resultJobId', 'quoteId', 'idempotencyKey', 'status', 'operationFingerprint', 'operationSnapshot', 'leaseToken', 'leasedUntil', 'errorCode', 'createdAt', 'updatedAt', 'completedAt'])

export type GenerationRetryRequestScalarFieldEnum = z.infer<typeof GenerationRetryRequestScalarFieldEnumSchema>;

// File: StorageUsageReservationScalarFieldEnum.schema.ts

export const StorageUsageReservationScalarFieldEnumSchema = z.enum(['id', 'ownerType', 'ownerId', 'bytes', 'status', 'referenceKey', 'createdAt', 'expiresAt', 'releasedAt'])

export type StorageUsageReservationScalarFieldEnum = z.infer<typeof StorageUsageReservationScalarFieldEnumSchema>;

// File: CreditAccountScalarFieldEnum.schema.ts

export const CreditAccountScalarFieldEnumSchema = z.enum(['id', 'ownerType', 'ownerId', 'spendableCredits', 'reservedCredits', 'creditDebt', 'version', 'createdAt', 'updatedAt'])

export type CreditAccountScalarFieldEnum = z.infer<typeof CreditAccountScalarFieldEnumSchema>;

// File: CreditLotScalarFieldEnum.schema.ts

export const CreditLotScalarFieldEnumSchema = z.enum(['id', 'accountId', 'grantReferenceKey', 'grantedAmount', 'remainingAmount', 'expiredUnrefundedAmount', 'reservedAmount', 'expiresAt', 'createdAt'])

export type CreditLotScalarFieldEnum = z.infer<typeof CreditLotScalarFieldEnumSchema>;

// File: CreditReservationScalarFieldEnum.schema.ts

export const CreditReservationScalarFieldEnumSchema = z.enum(['id', 'accountId', 'jobId', 'amount', 'settledAmount', 'releasedAmount', 'status', 'createdAt', 'updatedAt'])

export type CreditReservationScalarFieldEnum = z.infer<typeof CreditReservationScalarFieldEnumSchema>;

// File: CreditReservationAllocationScalarFieldEnum.schema.ts

export const CreditReservationAllocationScalarFieldEnumSchema = z.enum(['id', 'reservationId', 'lotId', 'amount', 'settledAmount', 'releasedAmount', 'revokedAmount', 'revokedSettledAmount', 'revokedReleasedAmount', 'createdAt'])

export type CreditReservationAllocationScalarFieldEnum = z.infer<typeof CreditReservationAllocationScalarFieldEnumSchema>;

// File: CreditLedgerEntryScalarFieldEnum.schema.ts

export const CreditLedgerEntryScalarFieldEnumSchema = z.enum(['id', 'accountId', 'lotId', 'reservationId', 'type', 'amount', 'referenceKey', 'metadata', 'createdAt'])

export type CreditLedgerEntryScalarFieldEnum = z.infer<typeof CreditLedgerEntryScalarFieldEnumSchema>;

// File: ProviderWebhookEventScalarFieldEnum.schema.ts

export const ProviderWebhookEventScalarFieldEnumSchema = z.enum(['id', 'provider', 'providerEventId', 'providerTaskId', 'verifiedAt', 'receivedAt', 'providerOccurredAt', 'providerSequence', 'envelope', 'status', 'processedAt', 'failureReason', 'processingToken', 'processingLeasedUntil'])

export type ProviderWebhookEventScalarFieldEnum = z.infer<typeof ProviderWebhookEventScalarFieldEnumSchema>;

// File: OutboxEventScalarFieldEnum.schema.ts

export const OutboxEventScalarFieldEnumSchema = z.enum(['id', 'eventType', 'aggregateType', 'aggregateId', 'dedupeKey', 'payload', 'status', 'attempts', 'availableAt', 'leaseOwner', 'leaseToken', 'leasedUntil', 'processedAt', 'lastError', 'createdAt'])

export type OutboxEventScalarFieldEnum = z.infer<typeof OutboxEventScalarFieldEnumSchema>;

// File: BillingPlanScalarFieldEnum.schema.ts

export const BillingPlanScalarFieldEnumSchema = z.enum(['id', 'provider', 'providerPriceId', 'name', 'creditsPerPeriod', 'priceMicros', 'currency', 'active', 'version', 'metadata', 'createdAt', 'updatedAt'])

export type BillingPlanScalarFieldEnum = z.infer<typeof BillingPlanScalarFieldEnumSchema>;

// File: SubscriptionScalarFieldEnum.schema.ts

export const SubscriptionScalarFieldEnumSchema = z.enum(['id', 'ownerType', 'ownerId', 'provider', 'providerSubscriptionId', 'planId', 'purchaseId', 'status', 'currentPeriodStart', 'currentPeriodEnd', 'cancelAtPeriodEnd', 'scheduledPlanId', 'lastProviderEventAt', 'lastProviderEventId', 'graceEndsAt', 'createdAt', 'updatedAt'])

export type SubscriptionScalarFieldEnum = z.infer<typeof SubscriptionScalarFieldEnumSchema>;

// File: BillingPeriodScalarFieldEnum.schema.ts

export const BillingPeriodScalarFieldEnumSchema = z.enum(['id', 'subscriptionId', 'startsAt', 'endsAt', 'status', 'creditAmount', 'grantReferenceKey', 'providerInvoiceId', 'providerChargeId', 'paidAmount', 'refundedAmount', 'refundedCredits', 'createdAt', 'updatedAt'])

export type BillingPeriodScalarFieldEnum = z.infer<typeof BillingPeriodScalarFieldEnumSchema>;

// File: PaymentEventScalarFieldEnum.schema.ts

export const PaymentEventScalarFieldEnumSchema = z.enum(['id', 'provider', 'providerEventId', 'normalizedTransactionId', 'verifiedAt', 'receivedAt', 'envelope', 'status', 'processedAt', 'failureReason', 'attemptCount', 'lastTriggerAttempt', 'lastAttemptAt', 'lastTriggerRunId', 'lastErrorClass', 'processingToken', 'processingLeasedUntil'])

export type PaymentEventScalarFieldEnum = z.infer<typeof PaymentEventScalarFieldEnumSchema>;

// File: RuntimeConfigOverrideScalarFieldEnum.schema.ts

export const RuntimeConfigOverrideScalarFieldEnumSchema = z.enum(['id', 'configKey', 'version', 'value', 'active', 'reason', 'createdByUserId', 'createdAt', 'revertedAt', 'revertedByUserId'])

export type RuntimeConfigOverrideScalarFieldEnum = z.infer<typeof RuntimeConfigOverrideScalarFieldEnumSchema>;

// File: AuditLogScalarFieldEnum.schema.ts

export const AuditLogScalarFieldEnumSchema = z.enum(['id', 'actorUserId', 'action', 'targetType', 'targetId', 'before', 'after', 'metadata', 'createdAt'])

export type AuditLogScalarFieldEnum = z.infer<typeof AuditLogScalarFieldEnumSchema>;

// File: RateLimitBucketScalarFieldEnum.schema.ts

export const RateLimitBucketScalarFieldEnumSchema = z.enum(['id', 'action', 'subjectHash', 'windowStart', 'windowEnd', 'count', 'updatedAt'])

export type RateLimitBucketScalarFieldEnum = z.infer<typeof RateLimitBucketScalarFieldEnumSchema>;

// File: GenerationDraftScalarFieldEnum.schema.ts

export const GenerationDraftScalarFieldEnumSchema = z.enum(['id', 'ownerType', 'ownerId', 'submittedByUserId', 'claimTokenHash', 'assetId', 'productKey', 'inputSnapshot', 'status', 'createdAt', 'updatedAt', 'expiresAt'])

export type GenerationDraftScalarFieldEnum = z.infer<typeof GenerationDraftScalarFieldEnumSchema>;

// File: NotificationScalarFieldEnum.schema.ts

export const NotificationScalarFieldEnumSchema = z.enum(['id', 'userId', 'type', 'data', 'link', 'read', 'createdAt', 'updatedAt'])

export type NotificationScalarFieldEnum = z.infer<typeof NotificationScalarFieldEnumSchema>;

// File: UserNotificationPreferenceScalarFieldEnum.schema.ts

export const UserNotificationPreferenceScalarFieldEnumSchema = z.enum(['id', 'userId', 'type', 'target', 'createdAt'])

export type UserNotificationPreferenceScalarFieldEnum = z.infer<typeof UserNotificationPreferenceScalarFieldEnumSchema>;

// File: SortOrder.schema.ts

export const SortOrderSchema = z.enum(['asc', 'desc'])

export type SortOrder = z.infer<typeof SortOrderSchema>;

// File: JsonNullValueInput.schema.ts

export const JsonNullValueInputSchema = z.enum(['JsonNull'])

export type JsonNullValueInput = z.infer<typeof JsonNullValueInputSchema>;

// File: NullableJsonNullValueInput.schema.ts

export const NullableJsonNullValueInputSchema = z.enum(['DbNull', 'JsonNull'])

export type NullableJsonNullValueInput = z.infer<typeof NullableJsonNullValueInputSchema>;

// File: QueryMode.schema.ts

export const QueryModeSchema = z.enum(['default', 'insensitive'])

export type QueryMode = z.infer<typeof QueryModeSchema>;

// File: NullsOrder.schema.ts

export const NullsOrderSchema = z.enum(['first', 'last'])

export type NullsOrder = z.infer<typeof NullsOrderSchema>;

// File: JsonNullValueFilter.schema.ts

export const JsonNullValueFilterSchema = z.enum(['DbNull', 'JsonNull', 'AnyNull'])

export type JsonNullValueFilter = z.infer<typeof JsonNullValueFilterSchema>;

// File: PurchaseType.schema.ts

export const PurchaseTypeSchema = z.enum(['SUBSCRIPTION', 'ONE_TIME'])

export type PurchaseType = z.infer<typeof PurchaseTypeSchema>;

// File: OwnerType.schema.ts

export const OwnerTypeSchema = z.enum(['USER', 'ORGANIZATION'])

export type OwnerType = z.infer<typeof OwnerTypeSchema>;

// File: GenerationJobStatus.schema.ts

export const GenerationJobStatusSchema = z.enum(['RESERVED', 'DISPATCH_QUEUED', 'SUBMITTING', 'PROVIDER_PENDING', 'PROVIDER_RUNNING', 'NEEDS_RECONCILIATION', 'FINALIZING', 'SUCCEEDED', 'FAILED', 'CANCELED'])

export type GenerationJobStatus = z.infer<typeof GenerationJobStatusSchema>;

// File: GenerationAttemptStatus.schema.ts

export const GenerationAttemptStatusSchema = z.enum(['CREATED', 'SUBMISSION_UNCERTAIN', 'SUBMITTED', 'RUNNING', 'NEEDS_RECONCILIATION', 'SUCCEEDED', 'FAILED', 'CANCELED'])

export type GenerationAttemptStatus = z.infer<typeof GenerationAttemptStatusSchema>;

// File: MediaAssetKind.schema.ts

export const MediaAssetKindSchema = z.enum(['INPUT', 'OUTPUT'])

export type MediaAssetKind = z.infer<typeof MediaAssetKindSchema>;

// File: MediaAssetStatus.schema.ts

export const MediaAssetStatusSchema = z.enum(['UPLOADING', 'VERIFYING', 'VERIFICATION_FAILED', 'READY', 'QUARANTINED', 'DELETED'])

export type MediaAssetStatus = z.infer<typeof MediaAssetStatusSchema>;

// File: UploadSessionStatus.schema.ts

export const UploadSessionStatusSchema = z.enum(['PENDING', 'FINALIZING', 'COMPLETED', 'EXPIRED', 'ABORTED'])

export type UploadSessionStatus = z.infer<typeof UploadSessionStatusSchema>;

// File: GenerationJobAssetRole.schema.ts

export const GenerationJobAssetRoleSchema = z.enum(['INPUT', 'OUTPUT'])

export type GenerationJobAssetRole = z.infer<typeof GenerationJobAssetRoleSchema>;

// File: ModerationStatus.schema.ts

export const ModerationStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'REVIEW', 'ERROR'])

export type ModerationStatus = z.infer<typeof ModerationStatusSchema>;

// File: GenerationRetryRequestStatus.schema.ts

export const GenerationRetryRequestStatusSchema = z.enum(['PROCESSING', 'SUCCEEDED', 'FAILED'])

export type GenerationRetryRequestStatus = z.infer<typeof GenerationRetryRequestStatusSchema>;

// File: StorageReservationStatus.schema.ts

export const StorageReservationStatusSchema = z.enum(['ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED'])

export type StorageReservationStatus = z.infer<typeof StorageReservationStatusSchema>;

// File: CreditReservationStatus.schema.ts

export const CreditReservationStatusSchema = z.enum(['ACTIVE', 'SETTLED', 'RELEASED'])

export type CreditReservationStatus = z.infer<typeof CreditReservationStatusSchema>;

// File: CreditLedgerEntryType.schema.ts

export const CreditLedgerEntryTypeSchema = z.enum(['GRANT', 'RESERVE', 'SETTLE', 'RELEASE', 'EXPIRE', 'REFUND', 'DEBT_REPAYMENT', 'DEBT_INCURRED'])

export type CreditLedgerEntryType = z.infer<typeof CreditLedgerEntryTypeSchema>;

// File: EventProcessingStatus.schema.ts

export const EventProcessingStatusSchema = z.enum(['RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED', 'DEAD_LETTER'])

export type EventProcessingStatus = z.infer<typeof EventProcessingStatusSchema>;

// File: OutboxEventStatus.schema.ts

export const OutboxEventStatusSchema = z.enum(['PENDING', 'LEASED', 'PROCESSED', 'DEAD_LETTER'])

export type OutboxEventStatus = z.infer<typeof OutboxEventStatusSchema>;

// File: SubscriptionStatus.schema.ts

export const SubscriptionStatusSchema = z.enum(['PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'])

export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

// File: BillingPeriodStatus.schema.ts

export const BillingPeriodStatusSchema = z.enum(['PENDING', 'ACTIVE', 'CLOSED', 'VOID', 'REFUNDED'])

export type BillingPeriodStatus = z.infer<typeof BillingPeriodStatusSchema>;

// File: GenerationDraftStatus.schema.ts

export const GenerationDraftStatusSchema = z.enum(['ACTIVE', 'SUBMITTED', 'EXPIRED'])

export type GenerationDraftStatus = z.infer<typeof GenerationDraftStatusSchema>;

// File: NotificationType.schema.ts

export const NotificationTypeSchema = z.enum(['WELCOME', 'APP_UPDATE'])

export type NotificationType = z.infer<typeof NotificationTypeSchema>;

// File: NotificationTarget.schema.ts

export const NotificationTargetSchema = z.enum(['IN_APP', 'EMAIL'])

export type NotificationTarget = z.infer<typeof NotificationTargetSchema>;

// File: User.schema.ts

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  role: z.string().nullish(),
  banned: z.boolean().nullish(),
  banReason: z.string().nullish(),
  banExpires: z.date().nullish(),
  onboardingComplete: z.boolean(),
  paymentsCustomerId: z.string().nullish(),
  locale: z.string().nullish(),
  twoFactorEnabled: z.boolean().nullish(),
  lastActiveOrganizationId: z.string().nullish(),
});

export type UserType = z.infer<typeof UserSchema>;


// File: Session.schema.ts

export const SessionSchema = z.object({
  id: z.string(),
  expiresAt: z.date(),
  ipAddress: z.string().nullish(),
  userAgent: z.string().nullish(),
  userId: z.string(),
  impersonatedBy: z.string().nullish(),
  activeOrganizationId: z.string().nullish(),
  token: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type SessionType = z.infer<typeof SessionSchema>;


// File: Account.schema.ts

export const AccountSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  providerId: z.string(),
  userId: z.string(),
  accessToken: z.string().nullish(),
  refreshToken: z.string().nullish(),
  idToken: z.string().nullish(),
  expiresAt: z.date().nullish(),
  password: z.string().nullish(),
  accessTokenExpiresAt: z.date().nullish(),
  refreshTokenExpiresAt: z.date().nullish(),
  scope: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AccountType = z.infer<typeof AccountSchema>;


// File: Verification.schema.ts

export const VerificationSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  value: z.string(),
  expiresAt: z.date(),
  createdAt: z.date().nullish(),
  updatedAt: z.date().nullish(),
});

export type VerificationType = z.infer<typeof VerificationSchema>;


// File: Passkey.schema.ts

export const PasskeySchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  publicKey: z.string(),
  userId: z.string(),
  credentialID: z.string(),
  counter: z.number().int(),
  deviceType: z.string(),
  backedUp: z.boolean(),
  transports: z.string().nullish(),
  aaguid: z.string().nullish(),
  createdAt: z.date().nullish(),
});

export type PasskeyType = z.infer<typeof PasskeySchema>;


// File: TwoFactor.schema.ts

export const TwoFactorSchema = z.object({
  id: z.string(),
  secret: z.string(),
  backupCodes: z.string(),
  verified: z.boolean(),
  userId: z.string(),
  failedVerificationCount: z.number().int().nullish(),
  lockedUntil: z.date().nullish(),
});

export type TwoFactorType = z.infer<typeof TwoFactorSchema>;


// File: Organization.schema.ts

export const OrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullish(),
  logo: z.string().nullish(),
  createdAt: z.date(),
  metadata: z.string().nullish(),
  paymentsCustomerId: z.string().nullish(),
});

export type OrganizationType = z.infer<typeof OrganizationSchema>;


// File: Member.schema.ts

export const MemberSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  role: z.string(),
  createdAt: z.date(),
});

export type MemberType = z.infer<typeof MemberSchema>;


// File: Invitation.schema.ts

export const InvitationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  email: z.string(),
  role: z.string().nullish(),
  status: z.string(),
  expiresAt: z.date(),
  inviterId: z.string(),
  createdAt: z.date(),
});

export type InvitationType = z.infer<typeof InvitationSchema>;


// File: Purchase.schema.ts

export const PurchaseSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullish(),
  userId: z.string().nullish(),
  type: PurchaseTypeSchema,
  customerId: z.string(),
  subscriptionId: z.string().nullish(),
  priceId: z.string(),
  status: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PurchaseModel = z.infer<typeof PurchaseSchema>;

// File: GenerationQuote.schema.ts

export const GenerationQuoteSchema = z.object({
  id: z.string(),
  ownerType: OwnerTypeSchema,
  ownerId: z.string(),
  submittedByUserId: z.string(),
  productKey: z.string(),
  catalogVersion: z.string(),
  pricingVersion: z.string(),
  credits: z.bigint(),
  costMicros: z.bigint(),
  inputSnapshot: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  pricingSnapshot: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  moderationDecision: z.string().default("LEGACY_UNREVIEWED"),
  moderationProvider: z.string().default("legacy"),
  moderationRuleVersion: z.string().default("legacy"),
  moderationReasonCode: z.string().default("LEGACY_UNREVIEWED"),
  inputFingerprint: z.string(),
  createdAt: z.date(),
  expiresAt: z.date(),
});

export type GenerationQuoteType = z.infer<typeof GenerationQuoteSchema>;


// File: GenerationJob.schema.ts

export const GenerationJobSchema = z.object({
  id: z.string(),
  ownerType: OwnerTypeSchema,
  ownerId: z.string(),
  submittedByUserId: z.string(),
  quoteId: z.string(),
  idempotencyKey: z.string(),
  productKey: z.string(),
  catalogVersion: z.string(),
  pricingVersion: z.string(),
  creditsReserved: z.bigint(),
  inputSnapshot: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  pricingSnapshot: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  status: GenerationJobStatusSchema.default("RESERVED"),
  version: z.number().int(),
  failureCode: z.string().nullish(),
  failureMessage: z.string().nullish(),
  finalizationStage: z.string().nullish(),
  finalizationRetryCount: z.number().int(),
  finalizationErrorCode: z.string().nullish(),
  nextFinalizeAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  terminalAt: z.date().nullish(),
});

export type GenerationJobType = z.infer<typeof GenerationJobSchema>;


// File: GenerationAttempt.schema.ts

export const GenerationAttemptSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  attemptNumber: z.number().int(),
  provider: z.string(),
  providerModelId: z.string(),
  providerTaskId: z.string().nullish(),
  providerStatusUrl: z.string().nullish(),
  providerResultUrl: z.string().nullish(),
  submissionToken: z.string().nullish(),
  status: GenerationAttemptStatusSchema.default("CREATED"),
  providerCostMicros: z.bigint().nullish(),
  progress: z.number().int().nullish(),
  lastProviderEventAt: z.date().nullish(),
  lastProviderOccurredAt: z.date().nullish(),
  lastProviderReceivedAt: z.date().nullish(),
  lastProviderSequence: z.bigint().nullish(),
  uncertainSubmission: z.boolean(),
  reconciliationCount: z.number().int(),
  nextReconcileAt: z.date().nullish(),
  reconcileLeaseToken: z.string().nullish(),
  reconcileLeasedUntil: z.date().nullish(),
  requestSnapshot: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  responseSnapshot: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  errorSnapshot: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  submittedAt: z.date().nullish(),
  completedAt: z.date().nullish(),
});

export type GenerationAttemptType = z.infer<typeof GenerationAttemptSchema>;


// File: GenerationAttemptTransferEnvelope.schema.ts

export const GenerationAttemptTransferEnvelopeSchema = z.object({
  attemptId: z.string(),
  payload: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type GenerationAttemptTransferEnvelopeType = z.infer<typeof GenerationAttemptTransferEnvelopeSchema>;


// File: MediaAsset.schema.ts

export const MediaAssetSchema = z.object({
  id: z.string(),
  ownerType: OwnerTypeSchema,
  ownerId: z.string(),
  kind: MediaAssetKindSchema,
  status: MediaAssetStatusSchema.default("UPLOADING"),
  objectKey: z.string(),
  mimeType: z.string(),
  byteSize: z.bigint(),
  width: z.number().int().nullish(),
  height: z.number().int().nullish(),
  durationMillis: z.bigint().nullish(),
  checksum: z.string().nullish(),
  storageEtag: z.string().nullish(),
  storageVersionId: z.string().nullish(),
  finalizedAt: z.date().nullish(),
  outputTransferToken: z.string().nullish(),
  outputTransferLeaseExpiresAt: z.date().nullish(),
  outputStagingObjectKey: z.string().nullish(),
  outputPromotionMultipartUploadId: z.string().nullish(),
  sourceUrl: z.string().nullish(),
  verificationGeneration: z.number().int(),
  verificationAttemptCount: z.number().int(),
  verificationProvider: z.string().nullish(),
  verificationRuleVersion: z.string().nullish(),
  verificationPolicyVersion: z.string().nullish(),
  verificationProviderTaskId: z.string().nullish(),
  verificationLeaseToken: z.string().nullish(),
  verificationLeasedUntil: z.date().nullish(),
  verificationNextAttemptAt: z.date().nullish(),
  verificationDeadlineAt: z.date().nullish(),
  verificationExhaustedAt: z.date().nullish(),
  verificationValidUntil: z.date().nullish(),
  verificationSubmissionToken: z.string().nullish(),
  verificationSubmissionUncertain: z.boolean(),
  verificationSubmittedAt: z.date().nullish(),
  verificationLastErrorCode: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullish(),
});

export type MediaAssetType = z.infer<typeof MediaAssetSchema>;


// File: MediaUploadSession.schema.ts

export const MediaUploadSessionSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  tokenHash: z.string(),
  multipartUploadId: z.string().nullish(),
  stagingObjectKey: z.string().nullish(),
  stagedTerminalizationToken: z.string().nullish(),
  promotionMultipartUploadId: z.string().nullish(),
  promotionToken: z.string().nullish(),
  finalizationToken: z.string().nullish(),
  finalizationLeaseExpiresAt: z.date().nullish(),
  legacyFinalizationToken: z.string().nullish(),
  finalizationParts: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  status: UploadSessionStatusSchema.default("PENDING"),
  expectedBytes: z.bigint(),
  createdAt: z.date(),
  expiresAt: z.date(),
  completedAt: z.date().nullish(),
});

export type MediaUploadSessionType = z.infer<typeof MediaUploadSessionSchema>;


// File: GenerationJobAsset.schema.ts

export const GenerationJobAssetSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  assetId: z.string(),
  assetChecksum: z.string(),
  role: GenerationJobAssetRoleSchema,
  position: z.number().int(),
  createdAt: z.date(),
});

export type GenerationJobAssetType = z.infer<typeof GenerationJobAssetSchema>;


// File: AssetModerationResult.schema.ts

export const AssetModerationResultSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  assetChecksum: z.string().nullish(),
  verificationGeneration: z.number().int(),
  attemptNumber: z.number().int(),
  evidenceKind: MediaAssetKindSchema,
  provider: z.string(),
  providerTaskId: z.string().nullish(),
  ruleVersion: z.string(),
  policyVersion: z.string(),
  status: ModerationStatusSchema,
  reasonCode: z.string(),
  categories: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  rawEnvelope: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  validUntil: z.date().nullish(),
  createdAt: z.date(),
});

export type AssetModerationResultType = z.infer<typeof AssetModerationResultSchema>;


// File: GenerationRetryRequest.schema.ts

export const GenerationRetryRequestSchema = z.object({
  id: z.string(),
  ownerType: OwnerTypeSchema,
  ownerId: z.string(),
  submittedByUserId: z.string(),
  sourceJobId: z.string(),
  resultJobId: z.string().nullish(),
  quoteId: z.string().nullish(),
  idempotencyKey: z.string(),
  status: GenerationRetryRequestStatusSchema.default("PROCESSING"),
  operationFingerprint: z.string(),
  operationSnapshot: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  leaseToken: z.string().nullish(),
  leasedUntil: z.date().nullish(),
  errorCode: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
  completedAt: z.date().nullish(),
});

export type GenerationRetryRequestType = z.infer<typeof GenerationRetryRequestSchema>;


// File: StorageUsageReservation.schema.ts

export const StorageUsageReservationSchema = z.object({
  id: z.string(),
  ownerType: OwnerTypeSchema,
  ownerId: z.string(),
  bytes: z.bigint(),
  status: StorageReservationStatusSchema.default("ACTIVE"),
  referenceKey: z.string(),
  createdAt: z.date(),
  expiresAt: z.date(),
  releasedAt: z.date().nullish(),
});

export type StorageUsageReservationType = z.infer<typeof StorageUsageReservationSchema>;


// File: CreditAccount.schema.ts

export const CreditAccountSchema = z.object({
  id: z.string(),
  ownerType: OwnerTypeSchema,
  ownerId: z.string(),
  spendableCredits: z.bigint().default(BigInt(0)),
  reservedCredits: z.bigint().default(BigInt(0)),
  creditDebt: z.bigint().default(BigInt(0)),
  version: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type CreditAccountType = z.infer<typeof CreditAccountSchema>;


// File: CreditLot.schema.ts

export const CreditLotSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  grantReferenceKey: z.string(),
  grantedAmount: z.bigint(),
  remainingAmount: z.bigint(),
  expiredUnrefundedAmount: z.bigint().default(BigInt(0)),
  reservedAmount: z.bigint().default(BigInt(0)),
  expiresAt: z.date().nullish(),
  createdAt: z.date(),
});

export type CreditLotType = z.infer<typeof CreditLotSchema>;


// File: CreditReservation.schema.ts

export const CreditReservationSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  jobId: z.string(),
  amount: z.bigint(),
  settledAmount: z.bigint().default(BigInt(0)),
  releasedAmount: z.bigint().default(BigInt(0)),
  status: CreditReservationStatusSchema.default("ACTIVE"),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type CreditReservationType = z.infer<typeof CreditReservationSchema>;


// File: CreditReservationAllocation.schema.ts

export const CreditReservationAllocationSchema = z.object({
  id: z.string(),
  reservationId: z.string(),
  lotId: z.string(),
  amount: z.bigint(),
  settledAmount: z.bigint().default(BigInt(0)),
  releasedAmount: z.bigint().default(BigInt(0)),
  revokedAmount: z.bigint().default(BigInt(0)),
  revokedSettledAmount: z.bigint().default(BigInt(0)),
  revokedReleasedAmount: z.bigint().default(BigInt(0)),
  createdAt: z.date(),
});

export type CreditReservationAllocationType = z.infer<typeof CreditReservationAllocationSchema>;


// File: CreditLedgerEntry.schema.ts

export const CreditLedgerEntrySchema = z.object({
  id: z.string(),
  accountId: z.string(),
  lotId: z.string().nullish(),
  reservationId: z.string().nullish(),
  type: CreditLedgerEntryTypeSchema,
  amount: z.bigint(),
  referenceKey: z.string(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  createdAt: z.date(),
});

export type CreditLedgerEntryModel = z.infer<typeof CreditLedgerEntrySchema>;

// File: ProviderWebhookEvent.schema.ts

export const ProviderWebhookEventSchema = z.object({
  id: z.string(),
  provider: z.string(),
  providerEventId: z.string(),
  providerTaskId: z.string().nullish(),
  verifiedAt: z.date(),
  receivedAt: z.date(),
  providerOccurredAt: z.date().nullish(),
  providerSequence: z.bigint().nullish(),
  envelope: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  status: EventProcessingStatusSchema.default("RECEIVED"),
  processedAt: z.date().nullish(),
  failureReason: z.string().nullish(),
  processingToken: z.string().nullish(),
  processingLeasedUntil: z.date().nullish(),
});

export type ProviderWebhookEventType = z.infer<typeof ProviderWebhookEventSchema>;


// File: OutboxEvent.schema.ts

export const OutboxEventSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  dedupeKey: z.string(),
  payload: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  status: OutboxEventStatusSchema.default("PENDING"),
  attempts: z.number().int(),
  availableAt: z.date(),
  leaseOwner: z.string().nullish(),
  leaseToken: z.string().nullish(),
  leasedUntil: z.date().nullish(),
  processedAt: z.date().nullish(),
  lastError: z.string().nullish(),
  createdAt: z.date(),
});

export type OutboxEventType = z.infer<typeof OutboxEventSchema>;


// File: BillingPlan.schema.ts

export const BillingPlanSchema = z.object({
  id: z.string(),
  provider: z.string(),
  providerPriceId: z.string(),
  name: z.string(),
  creditsPerPeriod: z.bigint(),
  priceMicros: z.bigint(),
  currency: z.string(),
  active: z.boolean().default(true),
  version: z.number().int().default(1),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type BillingPlanType = z.infer<typeof BillingPlanSchema>;


// File: Subscription.schema.ts

export const SubscriptionSchema = z.object({
  id: z.string(),
  ownerType: OwnerTypeSchema,
  ownerId: z.string(),
  provider: z.string(),
  providerSubscriptionId: z.string(),
  planId: z.string(),
  purchaseId: z.string().nullish(),
  status: SubscriptionStatusSchema,
  currentPeriodStart: z.date().nullish(),
  currentPeriodEnd: z.date().nullish(),
  cancelAtPeriodEnd: z.boolean(),
  scheduledPlanId: z.string().nullish(),
  lastProviderEventAt: z.date().nullish(),
  lastProviderEventId: z.string().nullish(),
  graceEndsAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type SubscriptionType = z.infer<typeof SubscriptionSchema>;


// File: BillingPeriod.schema.ts

export const BillingPeriodSchema = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  startsAt: z.date(),
  endsAt: z.date(),
  status: BillingPeriodStatusSchema.default("PENDING"),
  creditAmount: z.bigint(),
  grantReferenceKey: z.string().nullish(),
  providerInvoiceId: z.string().nullish(),
  providerChargeId: z.string().nullish(),
  paidAmount: z.bigint().default(BigInt(0)),
  refundedAmount: z.bigint().default(BigInt(0)),
  refundedCredits: z.bigint().default(BigInt(0)),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type BillingPeriodType = z.infer<typeof BillingPeriodSchema>;


// File: PaymentEvent.schema.ts

export const PaymentEventSchema = z.object({
  id: z.string(),
  provider: z.string(),
  providerEventId: z.string(),
  normalizedTransactionId: z.string().nullish(),
  verifiedAt: z.date(),
  receivedAt: z.date(),
  envelope: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  status: EventProcessingStatusSchema.default("RECEIVED"),
  processedAt: z.date().nullish(),
  failureReason: z.string().nullish(),
  attemptCount: z.number().int(),
  lastTriggerAttempt: z.number().int().nullish(),
  lastAttemptAt: z.date().nullish(),
  lastTriggerRunId: z.string().nullish(),
  lastErrorClass: z.string().nullish(),
  processingToken: z.string().nullish(),
  processingLeasedUntil: z.date().nullish(),
});

export type PaymentEventType = z.infer<typeof PaymentEventSchema>;


// File: RuntimeConfigOverride.schema.ts

export const RuntimeConfigOverrideSchema = z.object({
  id: z.string(),
  configKey: z.string(),
  version: z.number().int(),
  value: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  active: z.boolean().default(true),
  reason: z.string(),
  createdByUserId: z.string(),
  createdAt: z.date(),
  revertedAt: z.date().nullish(),
  revertedByUserId: z.string().nullish(),
});

export type RuntimeConfigOverrideType = z.infer<typeof RuntimeConfigOverrideSchema>;


// File: AuditLog.schema.ts

export const AuditLogSchema = z.object({
  id: z.string(),
  actorUserId: z.string().nullish(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  before: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  after: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").nullish(),
  metadata: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  createdAt: z.date(),
});

export type AuditLogType = z.infer<typeof AuditLogSchema>;


// File: RateLimitBucket.schema.ts

export const RateLimitBucketSchema = z.object({
  id: z.string(),
  action: z.string(),
  subjectHash: z.string(),
  windowStart: z.date(),
  windowEnd: z.date(),
  count: z.bigint().default(BigInt(0)),
  updatedAt: z.date(),
});

export type RateLimitBucketType = z.infer<typeof RateLimitBucketSchema>;


// File: GenerationDraft.schema.ts

export const GenerationDraftSchema = z.object({
  id: z.string(),
  ownerType: OwnerTypeSchema,
  ownerId: z.string(),
  submittedByUserId: z.string(),
  claimTokenHash: z.string(),
  assetId: z.string().nullish(),
  productKey: z.string().nullish(),
  inputSnapshot: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10"),
  status: GenerationDraftStatusSchema.default("ACTIVE"),
  createdAt: z.date(),
  updatedAt: z.date(),
  expiresAt: z.date(),
});

export type GenerationDraftType = z.infer<typeof GenerationDraftSchema>;


// File: Notification.schema.ts

export const NotificationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: NotificationTypeSchema,
  data: z.unknown().refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > 10) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= 10; }, "JSON nesting depth exceeds maximum of 10").default({}),
  link: z.string().nullish(),
  read: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type NotificationModel = z.infer<typeof NotificationSchema>;

// File: UserNotificationPreference.schema.ts

export const UserNotificationPreferenceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: NotificationTypeSchema,
  target: NotificationTargetSchema,
  createdAt: z.date(),
});

export type UserNotificationPreferenceType = z.infer<typeof UserNotificationPreferenceSchema>;

