CREATE TABLE `photo_palettes` (
	`photo_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`version` integer NOT NULL,
	`swatches` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_photo_palettes_owner` ON `photo_palettes` (`owner_id`);