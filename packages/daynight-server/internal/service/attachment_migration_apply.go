package service

import (
	"context"
	"errors"
	"io/fs"
	"path"
	"reflect"
)

func (m *attachmentMigration) apply(ctx context.Context, resuming bool) (AttachmentMigrationSummary, error) {
	m.phase = "load"
	var manifest attachmentMigrationManifest
	hash, err := m.readJSON(m.directory()+"/manifest.json", &manifest)
	if err != nil {
		return AttachmentMigrationSummary{}, err
	}
	if err := m.validateManifest(manifest); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	var state attachmentMigrationState
	if _, err := m.readJSON(m.directory()+"/state.json", &state); err != nil {
		if !resuming || !errors.Is(err, fs.ErrNotExist) {
			return AttachmentMigrationSummary{}, err
		}
		state = attachmentMigrationState{Version: 1, OperationID: m.operation, ManifestSHA256: hash, Phase: "planned"}
	}
	if state.Version != 1 || state.OperationID != m.operation || state.ManifestSHA256 != hash || !attachmentMigrationPhaseValid(state.Phase) {
		return AttachmentMigrationSummary{}, m.failure("invalid_manifest", "The migration stage record does not match its immutable manifest.", nil)
	}
	m.phase = state.Phase
	if err := m.checkSnapshot(ctx, manifest); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	bucket, err := m.inspectDirectory(attachmentBucket)
	if err != nil {
		return AttachmentMigrationSummary{}, err
	}
	source, err := m.inspectDirectory(m.directory() + "/source")
	if err != nil {
		return AttachmentMigrationSummary{}, err
	}
	target, err := m.inspectDirectory(m.directory() + "/target")
	if err != nil {
		return AttachmentMigrationSummary{}, err
	}
	if manifest.summary("planned").TaskCount == 0 {
		if source || target || bucket != manifest.BucketExists || state.Phase != "planned" && state.Phase != "complete" {
			return AttachmentMigrationSummary{}, m.failure("operation_conflict", "An empty migration has unexpected directory or stage state.", nil)
		}
		if bucket {
			if err := m.verifyTree(ctx, attachmentBucket, manifest, false, true); err != nil {
				return AttachmentMigrationSummary{}, err
			}
		}
		return m.complete(ctx, manifest, hash, state.Phase == "complete")
	}
	if bucket && !target && (state.Phase == "verified" || state.Phase == "published" || state.Phase == "complete") {
		if source {
			if err := m.requireEmpty(ctx, m.directory()+"/source"); err != nil {
				return AttachmentMigrationSummary{}, err
			}
		}
		if err := m.verifyTree(ctx, attachmentBucket, manifest, true, true); err != nil {
			return AttachmentMigrationSummary{}, err
		}
		return m.complete(ctx, manifest, hash, state.Phase == "complete")
	}
	if !resuming && (state.Phase != "planned" || source || target) {
		return AttachmentMigrationSummary{}, m.failure("resume_required", "The migration has started; use resume with this operation ID.", nil)
	}
	if bucket && !source && !target && (state.Phase == "planned" || state.Phase == "evacuated") {
		if err := m.verifyTree(ctx, attachmentBucket, manifest, false, true); err != nil {
			return AttachmentMigrationSummary{}, err
		}
		if err := m.saveState("evacuated", hash); err != nil {
			return AttachmentMigrationSummary{}, err
		}
		if err := m.rename(ctx, attachmentBucket, m.directory()+"/source"); err != nil {
			return AttachmentMigrationSummary{}, err
		}
		m.event(ctx, "evacuated", "bucket_evacuated", attachmentMigrationOwner{})
	} else if !bucket && source && (state.Phase == "planned" || state.Phase == "evacuated" || state.Phase == "placing" || state.Phase == "verified" || state.Phase == "published") {
		if target {
			if state.Phase == "planned" {
				return AttachmentMigrationSummary{}, m.failure("operation_conflict", "The migration directory state is ahead of its recorded operation.", nil)
			}
			if err := m.verifyPlacement(ctx, manifest); err != nil {
				return AttachmentMigrationSummary{}, err
			}
		} else {
			if state.Phase != "planned" && state.Phase != "evacuated" && state.Phase != "placing" {
				return AttachmentMigrationSummary{}, m.failure("operation_conflict", "The verified migration target is missing.", nil)
			}
			if err := m.verifyTree(ctx, m.directory()+"/source", manifest, false, true); err != nil {
				return AttachmentMigrationSummary{}, err
			}
		}
	} else {
		return AttachmentMigrationSummary{}, m.failure("operation_conflict", "The migration has ambiguous, missing, or conflicting directory locations.", nil)
	}
	if err := m.saveState("placing", hash); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	if err := m.makeParents(m.directory() + "/target"); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	for _, task := range manifest.Tasks {
		if !task.Exists {
			continue
		}
		sourceName := m.directory() + "/source/" + task.TaskID
		targetName := m.directory() + "/target/" + attachmentTaskStoragePath(task.ProjectID, task.TaskID)
		source, err := m.inspectDirectory(sourceName)
		if err != nil {
			return AttachmentMigrationSummary{}, err
		}
		target, err := m.inspectDirectory(targetName)
		if err != nil {
			return AttachmentMigrationSummary{}, err
		}
		if source == target {
			return AttachmentMigrationSummary{}, m.failure("operation_conflict", "A migration task must exist in exactly one source or target location.", nil)
		}
		if target {
			continue
		}
		if err := m.makeParents(path.Dir(targetName)); err != nil {
			return AttachmentMigrationSummary{}, err
		}
		if err := m.rename(ctx, sourceName, targetName); err != nil {
			return AttachmentMigrationSummary{}, err
		}
		m.event(ctx, "placing", "task_moved", attachmentMigrationOwner{ProjectID: task.ProjectID, TaskID: task.TaskID})
	}
	if err := m.requireEmpty(ctx, m.directory()+"/source"); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	if err := m.verifyTree(ctx, m.directory()+"/target", manifest, true, true); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	if err := m.saveState("verified", hash); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	m.event(ctx, "verified", "target_verified", attachmentMigrationOwner{})
	if err := m.checkSnapshot(ctx, manifest); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	if err := m.saveState("published", hash); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	if err := m.rename(ctx, m.directory()+"/target", attachmentBucket); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	m.event(ctx, "published", "bucket_published", attachmentMigrationOwner{})
	if err := m.verifyTree(ctx, attachmentBucket, manifest, true, false); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	return m.complete(ctx, manifest, hash, false)
}

func attachmentMigrationPhaseValid(phase string) bool {
	switch phase {
	case "planned", "evacuated", "placing", "verified", "published", "complete":
		return true
	default:
		return false
	}
}

func (m *attachmentMigration) requireEmpty(ctx context.Context, directory string) error {
	entries, err := m.readDirectory(ctx, directory)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		return m.failure("operation_conflict", "A migration source directory contains unplanned entries.", nil)
	}
	return nil
}

func (m *attachmentMigration) verifyPlacement(ctx context.Context, manifest attachmentMigrationManifest) error {
	remaining := map[string]bool{}
	placed := attachmentMigrationManifest{Tasks: []attachmentMigrationTask{}}
	for _, task := range manifest.Tasks {
		if !task.Exists {
			continue
		}
		sourceName := m.directory() + "/source/" + task.TaskID
		targetName := m.directory() + "/target/" + attachmentTaskStoragePath(task.ProjectID, task.TaskID)
		source, err := m.inspectDirectory(sourceName)
		if err != nil {
			return err
		}
		target, err := m.inspectDirectory(targetName)
		if err != nil {
			return err
		}
		if source == target {
			return m.failure("operation_conflict", "A migration task must exist in exactly one source or target location.", nil)
		}
		if source {
			if m.phase == "verified" || m.phase == "published" {
				return m.failure("operation_conflict", "A recorded verified target still has unmoved source tasks.", nil)
			}
			if err := m.verifyTask(ctx, sourceName, task.Entries, true); err != nil {
				return err
			}
			remaining[task.TaskID] = true
		} else {
			placed.Tasks = append(placed.Tasks, task)
		}
	}
	sourceEntries, err := m.readDirectory(ctx, m.directory()+"/source")
	if err != nil {
		return err
	}
	if len(sourceEntries) != len(remaining) {
		return m.failure("operation_conflict", "The migration source contains unexpected task directories.", nil)
	}
	for _, entry := range sourceEntries {
		if !remaining[entry.Name()] {
			return m.failure("operation_conflict", "The migration source contains an unplanned task directory.", nil)
		}
	}
	return m.verifyPartialTarget(ctx, placed, manifest)
}

func (m *attachmentMigration) verifyPartialTarget(ctx context.Context, placed, complete attachmentMigrationManifest) error {
	actual, err := m.inventory(ctx, m.directory()+"/target", true)
	if err != nil {
		return err
	}
	allowedParents := map[string]bool{".": true}
	expected := map[string]attachmentMigrationEntry{".": {Path: ".", Kind: "directory"}}
	for _, task := range complete.Tasks {
		if task.Exists {
			allowedParents[task.ProjectID] = true
			allowedParents[task.ProjectID+"/"+task.TaskID[:2]] = true
		}
	}
	for _, task := range placed.Tasks {
		prefix := attachmentTaskStoragePath(task.ProjectID, task.TaskID)
		for _, entry := range task.Entries {
			copy := entry
			copy.Path = prefix
			if entry.Path != "." {
				copy.Path += "/" + entry.Path
			}
			expected[copy.Path] = copy
		}
	}
	for _, entry := range actual {
		if entry.Kind == "directory" && allowedParents[entry.Path] {
			continue
		}
		if value, exists := expected[entry.Path]; !exists || !reflect.DeepEqual(value, entry) {
			return m.failure("content_changed", "The partial migration target contains unexpected or changed entries.", nil)
		}
		delete(expected, entry.Path)
	}
	delete(expected, ".")
	if len(expected) != 0 {
		return m.failure("content_changed", "The partial migration target is missing expected entries.", nil)
	}
	return nil
}

func (m *attachmentMigration) complete(ctx context.Context, manifest attachmentMigrationManifest, hash string, alreadyComplete bool) (AttachmentMigrationSummary, error) {
	if err := m.checkSnapshot(ctx, manifest); err != nil {
		return AttachmentMigrationSummary{}, err
	}
	summary := manifest.summary("complete")
	receipt := attachmentMigrationReceipt{AttachmentMigrationSummary: summary, ManifestSHA256: hash, DatabaseDigest: manifest.DatabaseDigest}
	var actual attachmentMigrationReceipt
	if _, err := m.readJSON(*summary.ReceiptPath, &actual); err == nil {
		if !reflect.DeepEqual(actual, receipt) {
			return AttachmentMigrationSummary{}, m.failure("operation_conflict", "The migration completion receipt differs from the verified operation.", nil)
		}
	} else if alreadyComplete || !errors.Is(err, fs.ErrNotExist) {
		return AttachmentMigrationSummary{}, err
	} else {
		if _, err := m.writeJSON(*summary.ReceiptPath, receipt, false); err != nil {
			return AttachmentMigrationSummary{}, err
		}
	}
	if !alreadyComplete {
		if err := m.saveState("complete", hash); err != nil {
			return AttachmentMigrationSummary{}, err
		}
	}
	m.event(ctx, "complete", "complete", attachmentMigrationOwner{})
	return summary, nil
}
