<?php
/**
 * The one-page body: Hero · Services · About · Service Area · Contact.
 *
 * @package BuiltRiteMarine
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$brm_email = brm_get( 'email' );
?>

<!-- ============ HERO ============ -->
<section class="hero" id="top">
	<div class="wrap hero__inner">
		<p class="eyebrow"><?php echo esc_html( brm_get( 'hero_kicker' ) ); ?></p>
		<h1>
			<?php
			$brm_name  = get_bloginfo( 'name' );
			$brm_words = explode( ' ', $brm_name );
			$brm_last  = array_pop( $brm_words );
			echo esc_html( implode( ' ', $brm_words ) );
			echo $brm_words ? '<span class="accent">' . esc_html( $brm_last ) . '</span>' : esc_html( $brm_last );
			?>
		</h1>
		<p class="hero__tagline"><?php echo esc_html( brm_get( 'tagline' ) ); ?></p>

		<div class="hero__actions">
			<?php echo brm_call_link( 'btn btn--call btn--lg', 'Call ' . brm_get( 'phone' ) ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
			<a class="btn btn--ghost btn--lg" href="#services"><?php esc_html_e( 'See Services', 'built-rite-marine' ); ?></a>
		</div>

		<span class="hero__phone">
			<?php esc_html_e( 'Call or text', 'built-rite-marine' ); ?>
			<?php echo brm_call_link( '', '' ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
		</span>
	</div>
</section>

<!-- ============ TRUST BAR ============ -->
<?php $brm_trust = brm_lines( 'trust_points' ); ?>
<?php if ( $brm_trust ) : ?>
<div class="trustbar">
	<div class="wrap">
		<ul class="trustbar__inner">
			<?php foreach ( $brm_trust as $brm_point ) : ?>
				<li><span class="dot" aria-hidden="true"></span><?php echo esc_html( $brm_point ); ?></li>
			<?php endforeach; ?>
		</ul>
	</div>
</div>
<?php endif; ?>

<!-- ============ SERVICES ============ -->
<section class="section section--light" id="services">
	<div class="wrap">
		<p class="eyebrow"><?php esc_html_e( 'What Shannon Works On', 'built-rite-marine' ); ?></p>
		<h2 class="section-title"><?php esc_html_e( 'Services', 'built-rite-marine' ); ?></h2>
		<?php if ( brm_get( 'services_intro' ) ) : ?>
			<p class="lead"><?php echo esc_html( brm_get( 'services_intro' ) ); ?></p>
		<?php endif; ?>

		<div class="services__grid">
			<?php foreach ( brm_services_list() as $brm_svc ) : ?>
				<article class="service-card">
					<h3><?php echo esc_html( $brm_svc['title'] ); ?></h3>
					<?php if ( $brm_svc['desc'] ) : ?>
						<p><?php echo esc_html( $brm_svc['desc'] ); ?></p>
					<?php endif; ?>
				</article>
			<?php endforeach; ?>
		</div>
	</div>
</section>

<!-- ============ ABOUT ============ -->
<section class="section section--navy" id="about">
	<div class="wrap about__grid">
		<div class="about__body">
			<p class="eyebrow"><?php esc_html_e( 'About', 'built-rite-marine' ); ?></p>
			<h2 class="section-title"><?php echo esc_html( brm_get( 'about_heading' ) ); ?></h2>
			<?php
			$brm_paras = preg_split( '/\n\s*\n/', brm_get( 'about_text' ) );
			foreach ( $brm_paras as $brm_para ) {
				$brm_para = trim( $brm_para );
				if ( '' !== $brm_para ) {
					echo '<p>' . esc_html( $brm_para ) . '</p>';
				}
			}
			?>
			<?php if ( brm_get( 'about_signature' ) ) : ?>
				<p class="about__signature">
					— <?php echo esc_html( brm_get( 'about_signature' ) ); ?>
					<span><?php esc_html_e( 'Built Rite Marine', 'built-rite-marine' ); ?></span>
				</p>
			<?php endif; ?>
		</div>

		<?php $brm_why = brm_lines( 'why_points' ); ?>
		<?php if ( $brm_why ) : ?>
		<aside class="about__card">
			<h3><?php esc_html_e( 'Why Shannon', 'built-rite-marine' ); ?></h3>
			<ul class="about__list">
				<?php foreach ( $brm_why as $brm_item ) : ?>
					<li><span class="check" aria-hidden="true">✦</span><span><?php echo esc_html( $brm_item ); ?></span></li>
				<?php endforeach; ?>
			</ul>
		</aside>
		<?php endif; ?>
	</div>
</section>

<!-- ============ SERVICE AREA ============ -->
<section class="section section--wood" id="area">
	<div class="wrap">
		<p class="eyebrow"><?php esc_html_e( 'Service Area', 'built-rite-marine' ); ?></p>
		<h2 class="section-title"><?php echo esc_html( brm_get( 'area_heading' ) ); ?></h2>
		<?php if ( brm_get( 'area_text' ) ) : ?>
			<p class="lead"><?php echo esc_html( brm_get( 'area_text' ) ); ?></p>
		<?php endif; ?>

		<?php $brm_towns = brm_lines( 'area_towns' ); ?>
		<?php if ( $brm_towns ) : ?>
			<ul class="area__towns">
				<?php foreach ( $brm_towns as $brm_town ) : ?>
					<li><?php echo esc_html( $brm_town ); ?></li>
				<?php endforeach; ?>
			</ul>
		<?php endif; ?>

		<?php if ( brm_get( 'area_note' ) ) : ?>
			<p class="area__note"><?php echo esc_html( brm_get( 'area_note' ) ); ?></p>
		<?php endif; ?>
	</div>
</section>

<!-- ============ CONTACT / CTA ============ -->
<section class="section contact" id="contact">
	<div class="wrap">
		<p class="eyebrow"><?php esc_html_e( 'Get in Touch', 'built-rite-marine' ); ?></p>
		<h2 class="section-title"><?php echo esc_html( brm_get( 'cta_heading' ) ); ?></h2>
		<?php if ( brm_get( 'cta_text' ) ) : ?>
			<p class="lead"><?php echo esc_html( brm_get( 'cta_text' ) ); ?></p>
		<?php endif; ?>

		<div class="contact__grid" style="margin-top:2.5rem;">
			<div class="contact__phone-block">
				<p class="contact__bignum"><?php echo brm_call_link( '', '' ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?></p>
				<div class="contact__meta">
					<?php if ( brm_get( 'hours' ) ) : ?>
						<div><span class="label"><?php esc_html_e( 'Hours', 'built-rite-marine' ); ?></span><span><?php echo esc_html( brm_get( 'hours' ) ); ?></span></div>
					<?php endif; ?>
					<?php if ( $brm_email ) : ?>
						<div><span class="label"><?php esc_html_e( 'Email', 'built-rite-marine' ); ?></span><a href="mailto:<?php echo esc_attr( $brm_email ); ?>"><?php echo esc_html( $brm_email ); ?></a></div>
					<?php endif; ?>
					<div><span class="label"><?php esc_html_e( 'Area', 'built-rite-marine' ); ?></span><span><?php esc_html_e( 'Sonoma County, CA', 'built-rite-marine' ); ?></span></div>
				</div>
				<p style="margin-top:1.75rem;">
					<?php echo brm_call_link( 'btn btn--call btn--lg', 'Call ' . brm_get( 'phone' ) ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
				</p>
			</div>

			<?php if ( get_theme_mod( 'brm_show_form', true ) ) : ?>
				<?php get_template_part( 'template-parts/contact-form' ); ?>
			<?php endif; ?>
		</div>
	</div>
</section>
