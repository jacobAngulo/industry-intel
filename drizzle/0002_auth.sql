CREATE TABLE `access_request` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_request_user_unique` ON `access_request` (`user_id`);--> statement-breakpoint
CREATE INDEX `access_request_status_idx` ON `access_request` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`last_sign_in_at` integer NOT NULL
);
--> statement-breakpoint
-- A vote of the old design belongs to a browser id, which is no person. There is
-- no mapping to an account, so the table starts empty.
DROP TABLE `feedback`;--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feed_id` integer NOT NULL,
	`story_id` integer NOT NULL,
	`reason` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_feed_story_user_unique` ON `feedback` (`feed_id`,`story_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `feedback_story_idx` ON `feedback` (`story_id`);--> statement-breakpoint
CREATE INDEX `feedback_feed_created_idx` ON `feedback` (`feed_id`,`created_at`);
