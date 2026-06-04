<?php
/**
 * Native contact form handler — no plugin required.
 *
 * Posts to admin-post.php, validated with a nonce + honeypot, sanitized, then
 * emailed via wp_mail(). On completion it redirects back to the #contact
 * anchor with a status flag so the form can show a success/error notice.
 *
 * @package BuiltRiteMarine
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Handle a submitted contact form (logged-in + logged-out).
 */
function brm_handle_contact() {
	$redirect = home_url( '/' );

	// Nonce check.
	if ( ! isset( $_POST['brm_nonce'] ) || ! wp_verify_nonce( sanitize_key( $_POST['brm_nonce'] ), 'brm_contact' ) ) {
		brm_contact_redirect( $redirect, 'err' );
	}

	// Honeypot: real users leave this empty.
	if ( ! empty( $_POST['brm_website'] ) ) {
		// Pretend success to silently drop bots.
		brm_contact_redirect( $redirect, 'ok' );
	}

	$name    = isset( $_POST['brm_name'] ) ? sanitize_text_field( wp_unslash( $_POST['brm_name'] ) ) : '';
	$phone   = isset( $_POST['brm_phone_field'] ) ? sanitize_text_field( wp_unslash( $_POST['brm_phone_field'] ) ) : '';
	$email   = isset( $_POST['brm_email_field'] ) ? sanitize_email( wp_unslash( $_POST['brm_email_field'] ) ) : '';
	$message = isset( $_POST['brm_message'] ) ? sanitize_textarea_field( wp_unslash( $_POST['brm_message'] ) ) : '';

	if ( '' === $name || ( '' === $phone && '' === $email ) || '' === $message ) {
		brm_contact_redirect( $redirect, 'err' );
	}

	$recipient = brm_get( 'form_recipient' );
	if ( ! is_email( $recipient ) ) {
		$recipient = get_option( 'admin_email' );
	}

	$subject = sprintf( '[%s] New inquiry from %s', get_bloginfo( 'name' ), $name );
	$body    = "New website inquiry\n\n";
	$body   .= 'Name:    ' . $name . "\n";
	$body   .= 'Phone:   ' . ( $phone ? $phone : '—' ) . "\n";
	$body   .= 'Email:   ' . ( $email ? $email : '—' ) . "\n\n";
	$body   .= "Message:\n" . $message . "\n";

	$headers = array( 'Content-Type: text/plain; charset=UTF-8' );
	if ( $email ) {
		$headers[] = 'Reply-To: ' . $name . ' <' . $email . '>';
	}

	$sent = wp_mail( $recipient, $subject, $body, $headers );

	brm_contact_redirect( $redirect, $sent ? 'ok' : 'err' );
}
add_action( 'admin_post_nopriv_brm_contact', 'brm_handle_contact' );
add_action( 'admin_post_brm_contact', 'brm_handle_contact' );

/**
 * Redirect back to the contact section with a status flag, then stop.
 *
 * @param string $base   Base URL.
 * @param string $status 'ok' | 'err'.
 */
function brm_contact_redirect( $base, $status ) {
	wp_safe_redirect( add_query_arg( 'brm_sent', $status, $base ) . '#contact' );
	exit;
}
