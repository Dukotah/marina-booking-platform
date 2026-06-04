<?php
/**
 * Header + sticky nav.
 *
 * @package BuiltRiteMarine
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
<!doctype html>
<html <?php language_attributes(); ?>>
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>" />
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
	<meta name="theme-color" content="#0d1822" />
	<link rel="profile" href="https://gmpg.org/xfn/11" />
	<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>

<a class="skip-link" href="#main"><?php esc_html_e( 'Skip to content', 'built-rite-marine' ); ?></a>

<header class="site-header">
	<div class="wrap site-header__bar">
		<a class="brand" href="<?php echo esc_url( home_url( '/' ) ); ?>" rel="home">
			<?php if ( has_custom_logo() ) : ?>
				<span class="brand__logo"><?php the_custom_logo(); ?></span>
			<?php else : ?>
				<span class="brand__mark"><?php echo esc_html( get_bloginfo( 'name' ) ); ?></span>
			<?php endif; ?>
		</a>

		<nav class="nav" aria-label="<?php esc_attr_e( 'Primary', 'built-rite-marine' ); ?>">
			<button class="nav-toggle" aria-expanded="false" aria-controls="primary-menu" aria-label="<?php esc_attr_e( 'Toggle menu', 'built-rite-marine' ); ?>">
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/></svg>
			</button>

			<?php
			if ( has_nav_menu( 'primary' ) ) {
				wp_nav_menu( array(
					'theme_location' => 'primary',
					'container'      => false,
					'menu_class'     => 'nav__links',
					'menu_id'        => 'primary-menu',
					'depth'          => 1,
					'fallback_cb'    => 'brm_default_nav',
				) );
			} else {
				brm_default_nav();
			}
			?>

			<?php echo brm_call_link( 'btn btn--call nav__call', '' ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in helper. ?>
		</nav>
	</div>
</header>

<main id="main">
