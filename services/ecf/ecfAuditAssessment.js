"use strict";
function assessAudit({ duplicates = [], withoutEnvironment = 0, uncertain = 0, orphanAttempts = 0,
                        invalidBranchDocuments = 0, missingIndex = false, danglingDocuments = 0,
                        missingLinkedOrders = 0, missingLinkedDocuments = 0 } = {}) {
  const duplicateGroups = duplicates.reduce((sum, x) => sum + (Number(x.duplicateGroups) || 0), 0);
  const blockers = [];
  const review = [];
  if (duplicateGroups) blockers.push("DUPLICATE_ENCF");
  if (missingIndex) blockers.push("ENCF_UNIQUE_INDEX_MISSING");
  if (invalidBranchDocuments) blockers.push("UNKNOWN_BRANCH_DOCUMENTS");
  if (orphanAttempts) review.push("ATTEMPTS_WITHOUT_DOCUMENT");
  if (danglingDocuments) review.push("DOCUMENTS_WITHOUT_ORDER");
  if (missingLinkedOrders) review.push("DOCUMENTS_WITH_MISSING_ORDER_REFERENCE");
  if (missingLinkedDocuments) review.push("ATTEMPTS_WITH_MISSING_DOCUMENT_REFERENCE");
  if (withoutEnvironment) review.push("LEGACY_ENVIRONMENT_UNRECORDED");
  if (uncertain) review.push("ATTEMPTS_NEEDS_REVIEW");
  return { readyForFinalAudit: blockers.length === 0 && review.length === 0, blockers, review,
    duplicateGroups, documentsWithoutEnvironment: withoutEnvironment,
    attemptsNeedsReview: uncertain, orphanAttempts, invalidBranchDocuments, danglingDocuments,
    missingLinkedOrders, missingLinkedDocuments };
}
module.exports = { assessAudit };
