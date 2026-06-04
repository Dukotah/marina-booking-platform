<?php
/**
 * Customizer settings — all editable content lives here.
 *
 * Appearance → Customize → "Built Rite Marine — Content".
 *
 * @package BuiltRiteMarine
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Register theme options.
 *
 * @param WP_Customize_Manager $wp_customize Customizer manager.
 */
function brm_customize_register( $wp_customize ) {
	$defaults = brm_defaults();

	$panel = 'brm_content';
	$wp_customize->add_panel( $panel, array(
		'title'       => __( 'Built Rite Marine — Content', 'built-rite-marine' ),
		'description' => __( 'Edit every piece of copy on the site. Placeholder text is in place until Shannon confirms the real details.', 'built-rite-marine' ),
		'priority'    => 10,
	) );

	/**
	 * Helper to add a setting + control in one call.
	 */
	$add = function ( $id, $args ) use ( $wp_customize, $defaults ) {
		$key       = str_replace( 'brm_', '', $id );
		$transport = isset( $args['transport'] ) ? $args['transport'] : 'refresh';
		$sanitize  = isset( $args['sanitize_callback'] ) ? $args['sanitize_callback'] : 'wp_kses_post';

		$wp_customize->add_setting( $id, array(
			'default'           => isset( $defaults[ $key ] ) ? $defaults[ $key ] : '',
			'sanitize_callback' => $sanitize,
			'transport'         => $transport,
		) );

		$wp_customize->add_control( $id, array(
			'label'       => $args['label'],
			'description' => isset( $args['description'] ) ? $args['description'] : '',
			'section'     => $args['section'],
			'type'        => isset( $args['type'] ) ? $args['type'] : 'text',
			'input_attrs' => isset( $args['input_attrs'] ) ? $args['input_attrs'] : array(),
		) );
	};

	/* ---- Section: Contact / Phone ---- */
	$wp_customize->add_section( 'brm_contact_sec', array(
		'title' => __( 'Phone & Contact', 'built-rite-marine' ),
		'panel' => $panel,
	) );
	$add( 'brm_phone', array(
		'label'             => __( 'Phone number', 'built-rite-marine' ),
		'description'       => __( 'Displayed everywhere and used for click-to-call. Format however you like, e.g. (707) 555-1234.', 'built-rite-marine' ),
		'section'           => 'brm_contact_sec',
		'sanitize_callback' => 'sanitize_text_field',
	) );
	$add( 'brm_email', array(
		'label'             => __( 'Public email (optional)', 'built-rite-marine' ),
		'section'           => 'brm_contact_sec',
		'type'              => 'email',
		'sanitize_callback' => 'sanitize_email',
	) );
	$add( 'brm_hours', array(
		'label'             => __( 'Hours / availability', 'built-rite-marine' ),
		'section'           => 'brm_contact_sec',
		'sanitize_callback' => 'sanitize_text_field',
	) );

	/* ---- Section: Hero ---- */
	$wp_customize->add_section( 'brm_hero_sec', array(
		'title' => __( 'Hero (top of page)', 'built-rite-marine' ),
		'panel' => $panel,
	) );
	$add( 'brm_hero_kicker', array(
		'label'             => __( 'Kicker (small line above name)', 'built-rite-marine' ),
		'section'           => 'brm_hero_sec',
		'sanitize_callback' => 'sanitize_text_field',
		'transport'         => 'postMessage',
	) );
	$add( 'brm_tagline', array(
		'label'             => __( 'Tagline', 'built-rite-marine' ),
		'section'           => 'brm_hero_sec',
		'type'              => 'textarea',
		'sanitize_callback' => 'sanitize_text_field',
		'transport'         => 'postMessage',
	) );
	$add( 'brm_trust_points', array(
		'label'             => __( 'Trust bar points (one per line)', 'built-rite-marine' ),
		'section'           => 'brm_hero_sec',
		'type'              => 'textarea',
	) );

	/* ---- Section: Services ---- */
	$wp_customize->add_section( 'brm_services_sec', array(
		'title' => __( 'Services', 'built-rite-marine' ),
		'panel' => $panel,
	) );
	$add( 'brm_services_intro', array(
		'label'   => __( 'Intro line', 'built-rite-marine' ),
		'section' => 'brm_services_sec',
		'type'    => 'textarea',
	) );
	$add( 'brm_services', array(
		'label'       => __( 'Services list', 'built-rite-marine' ),
		'description' => __( 'One service per line, in the format:  Title | Short description. The part after the | is optional.', 'built-rite-marine' ),
		'section'     => 'brm_services_sec',
		'type'        => 'textarea',
		'input_attrs' => array( 'rows' => 8 ),
	) );

	/* ---- Section: About ---- */
	$wp_customize->add_section( 'brm_about_sec', array(
		'title' => __( 'About Shannon', 'built-rite-marine' ),
		'panel' => $panel,
	) );
	$add( 'brm_about_heading', array(
		'label'             => __( 'Heading', 'built-rite-marine' ),
		'section'           => 'brm_about_sec',
		'sanitize_callback' => 'sanitize_text_field',
	) );
	$add( 'brm_about_text', array(
		'label'       => __( 'About text (blank line = new paragraph)', 'built-rite-marine' ),
		'section'     => 'brm_about_sec',
		'type'        => 'textarea',
		'input_attrs' => array( 'rows' => 7 ),
	) );
	$add( 'brm_about_signature', array(
		'label'             => __( 'Signature line', 'built-rite-marine' ),
		'section'           => 'brm_about_sec',
		'sanitize_callback' => 'sanitize_text_field',
	) );
	$add( 'brm_why_points', array(
		'label'       => __( '"Why Shannon" points (one per line)', 'built-rite-marine' ),
		'section'     => 'brm_about_sec',
		'type'        => 'textarea',
	) );

	/* ---- Section: Service Area ---- */
	$wp_customize->add_section( 'brm_area_sec', array(
		'title' => __( 'Service Area', 'built-rite-marine' ),
		'panel' => $panel,
	) );
	$add( 'brm_area_heading', array(
		'label'             => __( 'Heading', 'built-rite-marine' ),
		'section'           => 'brm_area_sec',
		'sanitize_callback' => 'sanitize_text_field',
	) );
	$add( 'brm_area_text', array(
		'label'   => __( 'Intro text', 'built-rite-marine' ),
		'section' => 'brm_area_sec',
		'type'    => 'textarea',
	) );
	$add( 'brm_area_towns', array(
		'label'       => __( 'Towns / areas (one per line)', 'built-rite-marine' ),
		'section'     => 'brm_area_sec',
		'type'        => 'textarea',
	) );
	$add( 'brm_area_note', array(
		'label'   => __( 'Note under towns', 'built-rite-marine' ),
		'section' => 'brm_area_sec',
		'type'    => 'textarea',
	) );

	/* ---- Section: Contact CTA + Form ---- */
	$wp_customize->add_section( 'brm_cta_sec', array(
		'title' => __( 'Contact Section & Form', 'built-rite-marine' ),
		'panel' => $panel,
	) );
	$add( 'brm_cta_heading', array(
		'label'             => __( 'Heading', 'built-rite-marine' ),
		'section'           => 'brm_cta_sec',
		'sanitize_callback' => 'sanitize_text_field',
	) );
	$add( 'brm_cta_text', array(
		'label'   => __( 'Text', 'built-rite-marine' ),
		'section' => 'brm_cta_sec',
		'type'    => 'textarea',
	) );

	$wp_customize->add_setting( 'brm_show_form', array(
		'default'           => true,
		'sanitize_callback' => 'brm_sanitize_checkbox',
	) );
	$wp_customize->add_control( 'brm_show_form', array(
		'label'       => __( 'Show contact form', 'built-rite-marine' ),
		'description' => __( 'A simple name/phone/message form that emails the recipient below. Phone is still the primary call-to-action.', 'built-rite-marine' ),
		'section'     => 'brm_cta_sec',
		'type'        => 'checkbox',
	) );
	$add( 'brm_form_recipient', array(
		'label'             => __( 'Form recipient email', 'built-rite-marine' ),
		'description'       => __( 'Where form submissions are sent. Defaults to the site admin email if left blank.', 'built-rite-marine' ),
		'section'           => 'brm_cta_sec',
		'type'              => 'email',
		'sanitize_callback' => 'sanitize_email',
	) );

	/* ---- Section: Footer ---- */
	$wp_customize->add_section( 'brm_footer_sec', array(
		'title' => __( 'Footer', 'built-rite-marine' ),
		'panel' => $panel,
	) );
	$add( 'brm_footer_note', array(
		'label'             => __( 'Footer note', 'built-rite-marine' ),
		'section'           => 'brm_footer_sec',
		'sanitize_callback' => 'sanitize_text_field',
	) );
}
add_action( 'customize_register', 'brm_customize_register' );

/**
 * Checkbox sanitizer.
 *
 * @param mixed $checked Raw value.
 * @return bool
 */
function brm_sanitize_checkbox( $checked ) {
	return ( isset( $checked ) && true === (bool) $checked );
}

/**
 * Live-preview JS for postMessage settings.
 */
function brm_customize_preview_js() {
	wp_enqueue_script(
		'brm-customize-preview',
		get_template_directory_uri() . '/assets/js/customizer.js',
		array( 'customize-preview' ),
		BRM_VERSION,
		true
	);
}
add_action( 'customize_preview_init', 'brm_customize_preview_js' );
