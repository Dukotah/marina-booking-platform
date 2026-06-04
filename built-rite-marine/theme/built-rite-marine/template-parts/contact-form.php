<?php
/**
 * Contact form markup. Submits to admin-post.php (handler in inc/contact-form.php).
 *
 * @package BuiltRiteMarine
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// Status flag set by the handler redirect (?brm_sent=ok|err).
$brm_status = isset( $_GET['brm_sent'] ) ? sanitize_key( wp_unslash( $_GET['brm_sent'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
?>
<form class="brm-form" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" method="post">
	<h3><?php esc_html_e( 'Send a Message', 'built-rite-marine' ); ?></h3>

	<?php if ( 'ok' === $brm_status ) : ?>
		<p class="brm-notice brm-notice--ok"><?php esc_html_e( 'Thanks — your message is on its way. Shannon will get back to you soon.', 'built-rite-marine' ); ?></p>
	<?php elseif ( 'err' === $brm_status ) : ?>
		<p class="brm-notice brm-notice--err"><?php esc_html_e( 'Sorry, something went wrong. Please give Shannon a call instead.', 'built-rite-marine' ); ?></p>
	<?php endif; ?>

	<div class="brm-field">
		<label for="brm_name"><?php esc_html_e( 'Your name', 'built-rite-marine' ); ?></label>
		<input type="text" id="brm_name" name="brm_name" required autocomplete="name" />
	</div>

	<div class="brm-field">
		<label for="brm_phone_field"><?php esc_html_e( 'Phone', 'built-rite-marine' ); ?></label>
		<input type="tel" id="brm_phone_field" name="brm_phone_field" autocomplete="tel" />
	</div>

	<div class="brm-field">
		<label for="brm_email_field"><?php esc_html_e( 'Email (optional)', 'built-rite-marine' ); ?></label>
		<input type="email" id="brm_email_field" name="brm_email_field" autocomplete="email" />
	</div>

	<div class="brm-field">
		<label for="brm_message"><?php esc_html_e( 'What does your boat need?', 'built-rite-marine' ); ?></label>
		<textarea id="brm_message" name="brm_message" required></textarea>
	</div>

	<!-- Honeypot: hidden from people, tempting to bots. -->
	<div class="brm-hp" aria-hidden="true">
		<label for="brm_website"><?php esc_html_e( 'Leave this field empty', 'built-rite-marine' ); ?></label>
		<input type="text" id="brm_website" name="brm_website" tabindex="-1" autocomplete="off" />
	</div>

	<input type="hidden" name="action" value="brm_contact" />
	<?php wp_nonce_field( 'brm_contact', 'brm_nonce' ); ?>

	<button type="submit" class="btn btn--call"><?php esc_html_e( 'Send Message', 'built-rite-marine' ); ?></button>
	<p style="margin:0;font-size:.85rem;opacity:.7;"><?php esc_html_e( 'Prefer to talk? Calling or texting is always fastest.', 'built-rite-marine' ); ?></p>
</form>
