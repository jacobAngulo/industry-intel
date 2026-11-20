CREATE TABLE `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer,
	`summary` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_at_idx` ON `activity` (`at`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feed_id` integer NOT NULL,
	`story_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`visible_at` integer NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_feed_story_unique` ON `alerts` (`feed_id`,`story_id`);--> statement-breakpoint
CREATE INDEX `alerts_feed_visible_idx` ON `alerts` (`feed_id`,`visible_at`);--> statement-breakpoint
CREATE INDEX `alerts_story_idx` ON `alerts` (`story_id`);--> statement-breakpoint
CREATE TABLE `analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feed_id` integer NOT NULL,
	`story_id` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text,
	`content` text,
	`error` text,
	`model` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`requested_by` text DEFAULT '' NOT NULL,
	`requested_at` integer NOT NULL,
	`started_at` integer,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analyses_feed_story_unique` ON `analyses` (`feed_id`,`story_id`);--> statement-breakpoint
CREATE INDEX `analyses_status_idx` ON `analyses` (`status`,`requested_at`);--> statement-breakpoint
CREATE INDEX `analyses_story_idx` ON `analyses` (`story_id`);--> statement-breakpoint
CREATE TABLE `digests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feed_id` integer NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`title` text NOT NULL,
	`entries` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digests_feed_period_end_unique` ON `digests` (`feed_id`,`period_end`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`level` text NOT NULL,
	`scope` text NOT NULL,
	`message` text NOT NULL,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `events_at_idx` ON `events` (`at`);--> statement-breakpoint
CREATE INDEX `events_level_idx` ON `events` (`level`,`at`);--> statement-breakpoint
CREATE TABLE `feed_sources` (
	`feed_id` integer NOT NULL,
	`source_id` integer NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`follow` text DEFAULT '' NOT NULL,
	`ignore` text DEFAULT '' NOT NULL,
	`added_by` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`feed_id`, `source_id`),
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feed_sources_source_idx` ON `feed_sources` (`source_id`);--> statement-breakpoint
CREATE TABLE `feed_topics` (
	`feed_id` integer NOT NULL,
	`topic_id` integer NOT NULL,
	`priority` text NOT NULL,
	PRIMARY KEY(`feed_id`, `topic_id`),
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feed_topics_topic_idx` ON `feed_topics` (`topic_id`);--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feed_id` integer NOT NULL,
	`story_id` integer NOT NULL,
	`reason` text NOT NULL,
	`client_id` text NOT NULL,
	`created_by` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_feed_story_client_unique` ON `feedback` (`feed_id`,`story_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `feedback_story_idx` ON `feedback` (`story_id`);--> statement-breakpoint
CREATE INDEX `feedback_feed_created_idx` ON `feedback` (`feed_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `feeds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`project_context` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`min_relevance` integer DEFAULT 60 NOT NULL,
	`half_life_hours` integer DEFAULT 48 NOT NULL,
	`exclusions` text NOT NULL,
	`relevance_priorities` text NOT NULL,
	`brief_format` text NOT NULL,
	`digest` text NOT NULL,
	`quiet_hours` text NOT NULL,
	`alerts` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feeds_slug_unique` ON `feeds` (`slug`);--> statement-breakpoint
CREATE INDEX `feeds_position_idx` ON `feeds` (`position`);--> statement-breakpoint
CREATE TABLE `item_links` (
	`item_id` integer NOT NULL,
	`url` text NOT NULL,
	PRIMARY KEY(`item_id`, `url`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `item_links_url_idx` ON `item_links` (`url`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`url` text,
	`canonical_url` text,
	`title` text DEFAULT '' NOT NULL,
	`author` text,
	`published_at` integer,
	`fetched_at` integer NOT NULL,
	`kind` text NOT NULL,
	`content_text` text DEFAULT '' NOT NULL,
	`content_hash` text DEFAULT '' NOT NULL,
	`meta` text NOT NULL,
	`substance` text,
	`story_id` integer,
	`judge_status` text DEFAULT 'pending' NOT NULL,
	`skip_reason` text,
	`judge_attempts` integer DEFAULT 0 NOT NULL,
	`judge_error` text,
	`next_judge_at` integer,
	`judge_locked_until` integer,
	`judged_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_source_external_unique` ON `items` (`source_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `items_canonical_url_idx` ON `items` (`canonical_url`);--> statement-breakpoint
CREATE INDEX `items_judge_idx` ON `items` (`judge_status`,`next_judge_at`);--> statement-breakpoint
CREATE INDEX `items_source_fetched_idx` ON `items` (`source_id`,`fetched_at`);--> statement-breakpoint
CREATE INDEX `items_story_idx` ON `items` (`story_id`);--> statement-breakpoint
CREATE TABLE `judgements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feed_id` integer NOT NULL,
	`story_id` integer NOT NULL,
	`relevance` integer NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`why_it_matters` text DEFAULT '' NOT NULL,
	`suggested_action` text,
	`topic_ids` text NOT NULL,
	`exclusion` text,
	`novelty` text NOT NULL,
	`depth` text NOT NULL,
	`signals` text NOT NULL,
	`alert` integer DEFAULT false NOT NULL,
	`base_score` real DEFAULT 0 NOT NULL,
	`rank_parts` text NOT NULL,
	`hidden_reason` text,
	`source_item_id` integer,
	`model` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`judged_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `judgements_feed_story_unique` ON `judgements` (`feed_id`,`story_id`);--> statement-breakpoint
CREATE INDEX `judgements_feed_hidden_score_idx` ON `judgements` (`feed_id`,`hidden_reason`,`base_score`);--> statement-breakpoint
CREATE INDEX `judgements_story_idx` ON `judgements` (`story_id`);--> statement-breakpoint
CREATE TABLE `rejudge_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feed_id` integer NOT NULL,
	`source_id` integer,
	`since_at` integer NOT NULL,
	`max_stories` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`requested_by` text DEFAULT '' NOT NULL,
	`requested_at` integer NOT NULL,
	`started_at` integer,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rejudge_requests_status_idx` ON `rejudge_requests` (`status`,`requested_at`);--> statement-breakpoint
CREATE INDEX `rejudge_requests_feed_idx` ON `rejudge_requests` (`feed_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `rejudge_requests_source_idx` ON `rejudge_requests` (`source_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`ok` integer NOT NULL,
	`items_found` integer DEFAULT 0 NOT NULL,
	`items_new` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_checks_source_idx` ON `source_checks` (`source_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `source_flags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_flags_source_idx` ON `source_flags` (`source_id`,`resolved_at`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`config` text NOT NULL,
	`why` text DEFAULT '' NOT NULL,
	`added_by` text DEFAULT '' NOT NULL,
	`owner` text,
	`paused` integer DEFAULT false NOT NULL,
	`check_interval_minutes` integer NOT NULL,
	`cursor` text,
	`next_check_at` integer DEFAULT 0 NOT NULL,
	`check_requested_at` integer,
	`locked_until` integer,
	`last_checked_at` integer,
	`last_success_at` integer,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_key_unique` ON `sources` (`key`);--> statement-breakpoint
CREATE INDEX `sources_due_idx` ON `sources` (`paused`,`next_check_at`);--> statement-breakpoint
CREATE INDEX `sources_type_idx` ON `sources` (`type`);--> statement-breakpoint
CREATE TABLE `stories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`headline` text NOT NULL,
	`summary` text NOT NULL,
	`category` text NOT NULL,
	`entities` text NOT NULL,
	`substance` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_item_at` integer NOT NULL,
	`fresh_at` integer NOT NULL,
	`item_count` integer DEFAULT 1 NOT NULL,
	`source_count` integer DEFAULT 1 NOT NULL,
	`primary_item_id` integer,
	`primary_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`primary_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `stories_last_item_idx` ON `stories` (`last_item_at`);--> statement-breakpoint
CREATE INDEX `stories_fresh_idx` ON `stories` (`fresh_at`);--> statement-breakpoint
CREATE TABLE `topics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text DEFAULT '' NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `topics_slug_unique` ON `topics` (`slug`);--> statement-breakpoint
CREATE TABLE `usage_daily` (
	`day` text NOT NULL,
	`metric` text NOT NULL,
	`value` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `metric`)
);
--> statement-breakpoint
CREATE TABLE `worker_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
