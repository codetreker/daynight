package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func initializePersonalTeam(ctx context.Context, tx pgx.Tx, userID string, now time.Time) error {
	var teamID string
	err := tx.QueryRow(ctx, `INSERT INTO teams (id,personal_user_id,created_at,updated_at)
		VALUES ($1,$2,$3,$3) ON CONFLICT (personal_user_id) DO NOTHING RETURNING id::text`, uuid.NewString(), userID, now).Scan(&teamID)
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO team_members (team_id,user_id,role,created_at,updated_at)
			VALUES ($1,$2,'admin',$3,$3)`, teamID, userID, now)
		return err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	_, err = personalTeam(ctx, tx, userID, "")
	return err
}

func personalTeam(ctx context.Context, tx pgx.Tx, userID, lock string) (string, error) {
	var teamID string
	err := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE personal_user_id=$1`+lock, userID).Scan(&teamID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("user Personal Team is missing")
	}
	if err != nil {
		return "", err
	}
	var valid bool
	err = tx.QueryRow(ctx, `SELECT count(*)=1 AND bool_and(user_id=$2 AND role='admin')
		FROM team_members WHERE team_id=$1`, teamID, userID).Scan(&valid)
	if err != nil {
		return "", err
	}
	if !valid {
		return "", fmt.Errorf("Personal Team owner membership is invalid")
	}
	return teamID, nil
}
