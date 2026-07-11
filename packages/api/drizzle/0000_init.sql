CREATE TABLE `execution_log` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`detail` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`source_order_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`customer_name` text,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_source_uq` ON `orders` (`source`,`source_order_id`);--> statement-breakpoint
CREATE TABLE `system_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhook_log` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`event_type` text NOT NULL,
	`source_order_id` text,
	`payload_hash` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error_slug` text,
	`error_message` text,
	`raw_key` text,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`processed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_log_hash_uq` ON `webhook_log` (`payload_hash`);--> statement-breakpoint
CREATE INDEX `webhook_log_status_idx` ON `webhook_log` (`status`,`received_at`);